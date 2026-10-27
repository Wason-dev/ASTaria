package dev.wason.ASTaria;

import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Rect;
import android.os.Build;
import android.view.View;
import android.view.ViewTreeObserver;
import android.view.Window;
import android.view.WindowManager;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.core.view.WindowInsetsAnimationCompat;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** One edge-to-edge inset owner for every supported WebView version. */
@CapacitorPlugin(name = "ASTariaAppearance")
public final class ASTariaAppearancePlugin extends Plugin {
    private boolean light = false;
    private View decor;
    private ViewTreeObserver.OnGlobalLayoutListener viewportListener;
    private String lastViewport = "";
    private long viewportRevision = 0;
    private final Set<WindowInsetsAnimationCompat> imeAnimations = new HashSet<>();
    private WindowInsetsCompat animatedInsets;

    @Override
    public void load() {
        super.load();
        getActivity().runOnUiThread(() -> {
            bridge.getWebView().setVerticalScrollBarEnabled(false);
            bridge.getWebView().setHorizontalScrollBarEnabled(false);
            decor = getActivity().getWindow().getDecorView();
            Window window = getActivity().getWindow();
            WindowCompat.setDecorFitsSystemWindows(window, false);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                WindowManager.LayoutParams attributes = window.getAttributes();
                attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                window.setAttributes(attributes);
            }
            // Android 11+ exposes real IME animation insets without resizing the
            // WebView to its final height before the keyboard has moved there.
            // Older releases retain adjustResize and the compat callback.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING);
            }
            decor.setPadding(0, 0, 0, 0);
            ViewCompat.setOnApplyWindowInsetsListener(decor, (view, insets) -> {
                // During an animation this callback receives the END state.
                // Only onProgress may publish it until that animation finishes.
                if (imeAnimations.isEmpty()) publishViewport(insets);
                return insets;
            });
            ViewCompat.setWindowInsetsAnimationCallback(decor,
                new WindowInsetsAnimationCompat.Callback(WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
                    @Override public void onPrepare(WindowInsetsAnimationCompat animation) {
                        if ((animation.getTypeMask() & WindowInsetsCompat.Type.ime()) != 0) {
                            if (imeAnimations.isEmpty()) animatedInsets = ViewCompat.getRootWindowInsets(decor);
                            imeAnimations.add(animation);
                        }
                    }
                    @Override public WindowInsetsCompat onProgress(WindowInsetsCompat insets, List<WindowInsetsAnimationCompat> running) {
                        animatedInsets = insets;
                        publishViewport(insets);
                        return insets;
                    }
                    @Override public void onEnd(WindowInsetsAnimationCompat animation) {
                        imeAnimations.remove(animation);
                        if (imeAnimations.isEmpty()) {
                            animatedInsets = null;
                            decor.post(ASTariaAppearancePlugin.this::publishViewport);
                        }
                    }
                });
            viewportListener = this::publishViewport;
            decor.getViewTreeObserver().addOnGlobalLayoutListener(viewportListener);
            applyTheme();
            ViewCompat.requestApplyInsets(decor);
            decor.post(this::publishViewport);
        });
    }

    @PluginMethod
    public void getViewport(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject viewport = readViewport();
            if (viewport == null) call.reject("Viewport not ready");
            else { viewport.put("revision", ++viewportRevision); call.resolve(viewport); }
        });
    }

    private void publishViewport() {
        if (decor == null || !imeAnimations.isEmpty()) return;
        publishViewport(ViewCompat.getRootWindowInsets(decor));
    }

    private void publishViewport(WindowInsetsCompat insets) {
        JSObject viewport = readViewport(insets);
        if (viewport == null) return;
        String value = viewport.toString();
        if (value.equals(lastViewport)) return;
        lastViewport = value;
        viewport.put("revision", ++viewportRevision);
        notifyListeners("viewportChanged", viewport);
    }

    @SuppressWarnings("deprecation")
    private JSObject readViewport() {
        return readViewport(animatedInsets != null ? animatedInsets : decor == null ? null : ViewCompat.getRootWindowInsets(decor));
    }

    @SuppressWarnings("deprecation")
    private JSObject readViewport(WindowInsetsCompat insets) {
        if (decor == null || bridge == null || bridge.getWebView() == null) return null;
        View webView = bridge.getWebView();
        if (insets == null || webView.getWidth() <= 0 || webView.getHeight() <= 0) return null;
        // IME can temporarily hide the gesture/navigation bar. Its stable size is
        // needed for the closed content baseline, independently of IME visibility.
        Insets bars = insets.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
        Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
        boolean keyboardVisible = ime.bottom > 0;
        float density = getActivity().getResources().getDisplayMetrics().density;
        int windowHeight;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // WindowMetrics includes the IME-covered portion, unlike the resized WebView.
            Rect bounds = getActivity().getWindowManager().getCurrentWindowMetrics().getBounds();
            windowHeight = bounds.height();
        } else {
            // Configuration describes this app window (also in split screen), not the
            // keyboard-resized visible display frame or the whole physical display.
            Configuration configuration = getActivity().getResources().getConfiguration();
            windowHeight = Math.round(configuration.screenHeightDp * density) + bars.top + bars.bottom;
        }
        int[] location = new int[2];
        webView.getLocationInWindow(location);
        int layoutHeight = Math.max(1, windowHeight - location[1]);
        int keyboardTop = keyboardVisible && ime.bottom > 0 ? windowHeight - location[1] - ime.bottom : layoutHeight;
        int visibleHeight = Math.max(1, Math.min(layoutHeight, keyboardTop));
        JSObject viewport = new JSObject();
        viewport.put("layoutWidth", webView.getWidth() / density);
        viewport.put("layoutHeight", layoutHeight / density);
        viewport.put("visibleHeight", visibleHeight / density);
        viewport.put("keyboardInset", keyboardVisible ? Math.max(0, layoutHeight - keyboardTop) / density : 0);
        viewport.put("keyboardVisible", keyboardVisible);
        viewport.put("keyboardAnimating", !imeAnimations.isEmpty());
        JSObject safeArea = new JSObject();
        safeArea.put("top", Math.max(0, bars.top - location[1]) / density);
        safeArea.put("right", bars.right / density);
        safeArea.put("bottom", bars.bottom / density);
        safeArea.put("left", bars.left / density);
        viewport.put("safeArea", safeArea);
        return viewport;
    }

    @PluginMethod
    public void setTheme(PluginCall call) {
        String theme = call.getString("theme");
        if (!"dark".equals(theme) && !"light".equals(theme)) {
            call.reject("Unsupported appearance");
            return;
        }
        getActivity().runOnUiThread(() -> {
            light = "light".equals(theme);
            applyTheme();
            call.resolve();
        });
    }

    @Override
    protected void handleOnConfigurationChanged(Configuration configuration) {
        super.handleOnConfigurationChanged(configuration);
        getActivity().getWindow().getDecorView().post(() -> { applyTheme(); publishViewport(); });
    }

    @Override
    protected void handleOnStart() {
        super.handleOnStart();
        getActivity().getWindow().getDecorView().post(() -> { applyTheme(); publishViewport(); });
    }

    @Override
    protected void handleOnDestroy() {
        if (decor != null && viewportListener != null && decor.getViewTreeObserver().isAlive()) {
            decor.getViewTreeObserver().removeOnGlobalLayoutListener(viewportListener);
        }
        if (decor != null) {
            ViewCompat.setWindowInsetsAnimationCallback(decor, null);
            ViewCompat.setOnApplyWindowInsetsListener(decor, null);
        }
        imeAnimations.clear();
        animatedInsets = null;
        decor = null;
        viewportListener = null;
        super.handleOnDestroy();
    }

    @SuppressWarnings("deprecation")
    private void applyTheme() {
        Window window = getActivity().getWindow();
        int background = Color.parseColor(light ? "#f8f6f2" : "#050506");
        window.getDecorView().setBackgroundColor(background);
        if (bridge != null && bridge.getWebView() != null) bridge.getWebView().setBackgroundColor(background);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // Some Android/Huawei themes retain a light navigation-bar divider
            // even when the bar itself is transparent.
            window.setNavigationBarDividerColor(Color.TRANSPARENT);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(light);
        controller.setAppearanceLightNavigationBars(light);
    }
}
