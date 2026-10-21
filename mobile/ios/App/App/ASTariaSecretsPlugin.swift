import Foundation
import Security
import Capacitor

/// One cloud API key, owned by this app. No caller-selected Keychain queries.
@objc(ASTariaSecretsPlugin)
public final class ASTariaSecretsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ASTariaSecretsPlugin"
    public let jsName = "ASTariaSecrets"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    private let service = "dev.wason.ASTaria.cloud-api"
    private let account = "cloud-api-key"
    private let maxKeyBytes = 4096
    private let storageLock = NSLock()

    private enum StorageFailure: Error {
        case unavailable, corrupt, writeFailed, removeFailed
    }

    @objc public func status(_ call: CAPPluginCall) {
        guard call.options.isEmpty else { rejectInput(call); return }
        storageLock.lock()
        defer { storageLock.unlock() }
        do {
            // Verify readability as well as existence; locked/corrupt is not unconfigured.
            let key = try readKey()
            call.resolve(["configured": key != nil])
        } catch { rejectStorage(call, error) }
    }

    @objc public func read(_ call: CAPPluginCall) {
        guard call.options.isEmpty else { rejectInput(call); return }
        storageLock.lock()
        defer { storageLock.unlock() }
        do {
            if let key = try readKey() {
                call.resolve(["key": key])
            } else {
                call.resolve(["key": NSNull()])
            }
        } catch { rejectStorage(call, error) }
    }

    @objc public func write(_ call: CAPPluginCall) {
        guard hasUserAction(call) else { rejectUserAction(call); return }
        guard call.options.count == 2, let key = call.getString("key"),
              let data = key.data(using: .utf8), validKey(data) else {
            rejectInput(call)
            return
        }
        storageLock.lock()
        defer { storageLock.unlock() }
        do {
            // A damaged record needs an explicit remove, never a silent reset.
            _ = try readKey()
            let attributes: [String: Any] = [
                kSecValueData as String: data,
                kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            ]
            let updated = SecItemUpdate(itemQuery() as CFDictionary, attributes as CFDictionary)
            if updated == errSecItemNotFound {
                var item = itemQuery()
                item.merge(attributes) { _, new in new }
                guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
                    throw StorageFailure.writeFailed
                }
            } else if updated != errSecSuccess {
                throw StorageFailure.writeFailed
            }
            call.resolve()
        } catch { rejectStorage(call, error) }
    }

    @objc public func remove(_ call: CAPPluginCall) {
        guard hasUserAction(call) else { rejectUserAction(call); return }
        guard call.options.count == 1 else { rejectInput(call); return }
        storageLock.lock()
        defer { storageLock.unlock() }
        // Removal also works for an unreadable record, and is idempotent when absent.
        let result = SecItemDelete(itemQuery() as CFDictionary)
        guard result == errSecSuccess || result == errSecItemNotFound else {
            rejectStorage(call, StorageFailure.removeFailed)
            return
        }
        call.resolve()
    }

    private func itemQuery() -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false
        ]
    }

    private func readKey() throws -> String? {
        var query = itemQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw StorageFailure.unavailable }
        guard let data = result as? Data, validKey(data),
              let key = String(data: data, encoding: .utf8) else {
            throw StorageFailure.corrupt
        }
        return key
    }

    private func validKey(_ data: Data) -> Bool {
        return !data.isEmpty && data.count <= maxKeyBytes
            && data.allSatisfy { $0 >= 0x21 && $0 <= 0x7e }
    }

    private func hasUserAction(_ call: CAPPluginCall) -> Bool {
        guard let value = call.options["userInitiated"] as? NSNumber else { return false }
        return CFGetTypeID(value) == CFBooleanGetTypeID() && value.boolValue
    }

    private func rejectInput(_ call: CAPPluginCall) {
        call.reject("API Key 必须为 1–4096 个不含空格的可见 ASCII 字符。", "SECRETS_INVALID_INPUT")
    }

    private func rejectUserAction(_ call: CAPPluginCall) {
        call.reject("请通过明确的保存或删除操作更改 API Key。", "SECRETS_USER_ACTION_REQUIRED")
    }

    private func rejectStorage(_ call: CAPPluginCall, _ error: Error) {
        // Never send OS errors, query attributes, or key data through the bridge.
        switch error as? StorageFailure {
        case .corrupt:
            call.reject("保存的 API Key 已损坏，请明确删除后重新保存。", "SECRETS_CORRUPT")
        case .writeFailed:
            call.reject("无法保存 API Key，请解锁设备后重试。", "SECRETS_WRITE_FAILED")
        case .removeFailed:
            call.reject("无法删除 API Key，请解锁设备后重试。", "SECRETS_REMOVE_FAILED")
        default:
            call.reject("安全存储暂时不可用，请解锁设备后重试。", "SECRETS_UNAVAILABLE")
        }
    }
}
