package dev.wason.ASTaria;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** One cloud API key. Only an authenticated ciphertext envelope is persisted. */
@CapacitorPlugin(name = "ASTariaSecrets")
public final class ASTariaSecretsPlugin extends Plugin {
    private static final String KEY_ALIAS = "dev.wason.ASTaria.cloud-api";
    private static final String PREFERENCES = "dev.wason.ASTaria.cloud-api.encrypted";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int MAX_KEY_BYTES = 4096;
    private static final int NONCE_BYTES = 12;
    private static final int TAG_BITS = 128;
    private static final byte RECORD_VERSION = 1;
    private static final int MAX_RECORD_BYTES = 1 + NONCE_BYTES + MAX_KEY_BYTES + TAG_BITS / 8;
    private static final int MAX_ENCODED_BYTES = ((MAX_RECORD_BYTES + 2) / 3) * 4;
    private static final byte[] AAD = KEY_ALIAS.getBytes(StandardCharsets.UTF_8);

    private static final class StorageFailure extends Exception {
        final String code;

        StorageFailure(String code) {
            this.code = code;
        }
    }

    /**
     * A single private ciphertext preference in Android's excluded no-backup domain.
     * Regular SharedPreferences can migrate on some OEMs despite allowBackup=false.
     * No plaintext, caller-selected paths, or generic preference API is exposed.
     */
    private static final class CiphertextPreferences {
        private final AtomicFile file;

        CiphertextPreferences(File path) {
            file = new AtomicFile(path);
        }

        String read() throws IOException {
            try (FileInputStream input = file.openRead()) {
                byte[] bytes = new byte[MAX_ENCODED_BYTES + 1];
                int length = 0;
                int count;
                while (length < bytes.length && (count = input.read(bytes, length, bytes.length - length)) != -1) {
                    length += count;
                }
                if (length > MAX_ENCODED_BYTES) throw new IOException("Invalid encrypted record size");
                return new String(bytes, 0, length, StandardCharsets.US_ASCII);
            } catch (FileNotFoundException failure) {
                File base = file.getBaseFile();
                if (base.exists() || new File(base.getPath() + ".bak").exists()) throw failure;
                return null;
            }
        }

        void write(String ciphertext) throws IOException {
            FileOutputStream output = file.startWrite();
            try {
                output.write(ciphertext.getBytes(StandardCharsets.US_ASCII));
                output.getFD().sync();
                file.finishWrite(output);
                output = null;
                // AtomicFile can log rather than throw on rename failure: verify persistence.
                if (!ciphertext.equals(read())) throw new IOException("Encrypted record was not saved");
            } finally {
                if (output != null) file.failWrite(output);
            }
        }

        void clear() throws IOException {
            file.delete();
            File base = file.getBaseFile();
            if (base.exists() || new File(base.getPath() + ".new").exists()
                || new File(base.getPath() + ".bak").exists()) {
                throw new IOException("Encrypted record was not removed");
            }
        }
    }

    @PluginMethod
    public synchronized void status(PluginCall call) {
        if (call.getData().length() != 0) { rejectInput(call); return; }
        try {
            String key = readKey(preferences());
            JSObject result = new JSObject();
            result.put("configured", key != null);
            call.resolve(result);
        } catch (Exception failure) { rejectStorage(call, failure, "SECRETS_UNAVAILABLE"); }
    }

    @PluginMethod
    public synchronized void read(PluginCall call) {
        if (call.getData().length() != 0) { rejectInput(call); return; }
        try {
            String key = readKey(preferences());
            JSObject result = new JSObject();
            result.put("key", key == null ? org.json.JSONObject.NULL : key);
            call.resolve(result);
        } catch (Exception failure) { rejectStorage(call, failure, "SECRETS_UNAVAILABLE"); }
    }

    @PluginMethod
    public synchronized void write(PluginCall call) {
        if (!Boolean.TRUE.equals(call.getBoolean("userInitiated"))) { rejectUserAction(call); return; }
        String key = call.getString("key");
        if (call.getData().length() != 2 || !validKey(key)) { rejectInput(call); return; }
        byte[] plaintext = key.getBytes(StandardCharsets.UTF_8);
        try {
            CiphertextPreferences prefs = preferences();
            // Never regenerate a key when ciphertext already exists but cannot be read.
            readKey(prefs);
            KeyStore store = keyStore();
            SecretKey encryptionKey = existingKey(store);
            if (encryptionKey == null) {
                KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
                generator.init(new KeyGenParameterSpec.Builder(
                    KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
                ).setKeySize(256)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build());
                encryptionKey = generator.generateKey();
            }
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            // Android Keystore generates a fresh random nonce; caller-supplied IVs are forbidden.
            cipher.init(Cipher.ENCRYPT_MODE, encryptionKey);
            byte[] nonce = cipher.getIV();
            if (nonce == null || nonce.length != NONCE_BYTES) throw new StorageFailure("SECRETS_WRITE_FAILED");
            cipher.updateAAD(AAD);
            byte[] ciphertext = cipher.doFinal(plaintext);
            byte[] record = ByteBuffer.allocate(1 + NONCE_BYTES + ciphertext.length)
                .put(RECORD_VERSION).put(nonce).put(ciphertext).array();
            prefs.write(Base64.encodeToString(record, Base64.NO_WRAP));
            call.resolve();
        } catch (Exception failure) { rejectStorage(call, failure, "SECRETS_WRITE_FAILED"); }
        finally { Arrays.fill(plaintext, (byte) 0); }
    }

    @PluginMethod
    public synchronized void remove(PluginCall call) {
        if (!Boolean.TRUE.equals(call.getBoolean("userInitiated"))) { rejectUserAction(call); return; }
        if (call.getData().length() != 1) { rejectInput(call); return; }
        boolean removed = true;
        try {
            KeyStore store = keyStore();
            if (store.containsAlias(KEY_ALIAS)) store.deleteEntry(KEY_ALIAS);
        } catch (Exception failure) { removed = false; }
        // Always attempt to discard ciphertext, including when Keystore is unavailable.
        try {
            preferences().clear();
        } catch (Exception failure) { removed = false; }
        if (!removed) {
            rejectStorage(call, new StorageFailure("SECRETS_REMOVE_FAILED"), "SECRETS_REMOVE_FAILED");
            return;
        }
        call.resolve();
    }

    private CiphertextPreferences preferences() throws StorageFailure {
        File directory = getContext().getNoBackupFilesDir();
        // Fail closed; a null parent would otherwise create a relative file path.
        if (directory == null || !directory.isDirectory()) throw new StorageFailure("SECRETS_UNAVAILABLE");
        return new CiphertextPreferences(new File(directory, PREFERENCES));
    }

    private KeyStore keyStore() throws Exception {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        return store;
    }

    private SecretKey existingKey(KeyStore store) throws Exception {
        if (!store.containsAlias(KEY_ALIAS)) return null;
        java.security.Key key;
        try { key = store.getKey(KEY_ALIAS, null); }
        catch (java.security.UnrecoverableKeyException failure) { throw new StorageFailure("SECRETS_KEY_LOST"); }
        if (!(key instanceof SecretKey)) throw new StorageFailure("SECRETS_KEY_LOST");
        return (SecretKey) key;
    }

    private String readKey(CiphertextPreferences prefs) throws Exception {
        String encoded = prefs.read();
        if (encoded == null) {
            // A surviving Keystore key means the record was lost, not never configured.
            if (keyStore().containsAlias(KEY_ALIAS)) throw new StorageFailure("SECRETS_CORRUPT");
            return null;
        }
        if (encoded.isEmpty() || encoded.length() > MAX_ENCODED_BYTES) throw new StorageFailure("SECRETS_CORRUPT");
        byte[] record;
        try { record = Base64.decode(encoded, Base64.NO_WRAP); }
        catch (IllegalArgumentException failure) { throw new StorageFailure("SECRETS_CORRUPT"); }
        if (record.length <= 1 + NONCE_BYTES + TAG_BITS / 8 || record.length > MAX_RECORD_BYTES
            || record[0] != RECORD_VERSION) throw new StorageFailure("SECRETS_CORRUPT");
        SecretKey encryptionKey = existingKey(keyStore());
        if (encryptionKey == null) throw new StorageFailure("SECRETS_KEY_LOST");
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        byte[] plaintext;
        try {
            cipher.init(Cipher.DECRYPT_MODE, encryptionKey,
                new GCMParameterSpec(TAG_BITS, Arrays.copyOfRange(record, 1, 1 + NONCE_BYTES)));
            cipher.updateAAD(AAD);
            plaintext = cipher.doFinal(Arrays.copyOfRange(record, 1 + NONCE_BYTES, record.length));
        } catch (java.security.GeneralSecurityException failure) {
            throw new StorageFailure("SECRETS_CORRUPT");
        }
        try {
            String key = new String(plaintext, StandardCharsets.UTF_8);
            if (!validKey(key)) throw new StorageFailure("SECRETS_CORRUPT");
            return key;
        } finally { Arrays.fill(plaintext, (byte) 0); }
    }

    private boolean validKey(String key) {
        if (key == null || key.isEmpty() || key.length() > MAX_KEY_BYTES) return false;
        for (int i = 0; i < key.length(); i++) {
            if (key.charAt(i) < 0x21 || key.charAt(i) > 0x7e) return false;
        }
        return true;
    }

    private void rejectInput(PluginCall call) {
        call.reject("API Key 必须为 1–4096 个不含空格的可见 ASCII 字符。", "SECRETS_INVALID_INPUT");
    }

    private void rejectUserAction(PluginCall call) {
        call.reject("请通过明确的保存或删除操作更改 API Key。", "SECRETS_USER_ACTION_REQUIRED");
    }

    private void rejectStorage(PluginCall call, Exception failure, String fallback) {
        String code = failure instanceof StorageFailure ? ((StorageFailure) failure).code : fallback;
        String message;
        switch (code) {
            case "SECRETS_KEY_LOST": message = "设备加密密钥不可用，请明确删除保存的 API Key 后重新保存。"; break;
            case "SECRETS_CORRUPT": message = "保存的 API Key 已损坏，请明确删除后重新保存。"; break;
            case "SECRETS_WRITE_FAILED": message = "无法保存 API Key，请解锁设备后重试。"; break;
            case "SECRETS_REMOVE_FAILED": message = "无法删除 API Key，请解锁设备后重试。"; break;
            default: message = "安全存储暂时不可用，请解锁设备后重试。";
        }
        // The overload without an Exception avoids Capacitor logging provider internals.
        call.reject(message, code);
    }
}
