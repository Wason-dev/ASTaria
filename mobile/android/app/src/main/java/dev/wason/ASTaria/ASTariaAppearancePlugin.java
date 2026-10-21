package dev.wason.ASTaria;

import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Rect;
import android.os.Build;
import android.view.View;
import android.view.ViewTreeObserver;
import android.view.Window;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Keep padded system-bar regions readable on older vendor WebViews. */
@CapacitorPlugin(name = "ASTariaAppearance")
public final class ASTariaAppearancePlugin extends Plugin {
    private boolean light = false;
    private View decor;
    private ViewTreeObserver.OnGlobalLayoutListener viewportListener;
    private String lastViewport = "";
    private int baselineWidth = 0;
    private int baselineHeight = 0;
    private int closedBottomPadding = -1;

    @Override
    public void load() {
        super.load();
        getActivity().runOnUiThread(() -> {
            decor = getActivity().getWindow().getDecorView();
            // SystemBars owns the decor's OnApplyWindowInsetsListener and safe-area CSS.
            // Read the original root insets after layout; never replace/consume its listener.
            viewportListener = this::publishViewport;
            decor.getViewTreeObserver().addOnGlobalLayoutListener(viewportListener);
            decor.post(this::publishViewport);
        });
    }

    @PluginMethod
    public void getViewport(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject viewport = readViewport();
            if (viewport == null) call.reject("Viewport not ready");
            else call.resolve(viewport);
        });
    }

    private void publishViewport() {
        JSObject viewport = readViewport();
        if (viewport == null) return;
        String value = viewport.toString();
        if (value.equals(lastViewport)) return;
        lastViewport = value;
        notifyListeners("viewportChanged", viewport);
    }

    @SuppressWarnings("deprecation")
    private JSObject readViewport() {
        if (decor == null || bridge == null || bridge.getWebView() == null) return null;
        View webView = bridge.getWebView();
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(decor);
        if (insets == null || webView.getWidth() <= 0 || webView.getHeight() <= 0) return null;
        // IME can temporarily hide the gesture/navigation bar. Its stable size is
        // needed for the closed content baseline, independently of IME visibility.
        Insets bars = insets.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
        Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
        boolean keyboardVisible = insets.isVisible(WindowInsetsCompat.Type.ime());
        float density = getActivity().getResources().getDisplayMetrics().density;
        int windowWidth;
        int windowHeight;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // WindowMetrics includes the IME-covered portion, unlike the resized WebView.
            Rect bounds = getActivity().getWindowManager().getCurrentWindowMetrics().getBounds();
            windowWidth = bounds.width();
            windowHeight = bounds.height();
        } else {
            // Configuration describes this app window (also in split screen), not the
            // keyboard-resized visible display frame or the whole physical display.
            Configuration configuration = getActivity().getResources().getConfiguration();
            windowWidth = Math.round(configuration.screenWidthDp * density) + bars.left + bars.right;
            windowHeight = Math.round(configuration.screenHeightDp * density) + bars.top + bars.bottom;
        }
        if (windowWidth != baselineWidth || windowHeight != baselineHeight) {
            baselineWidth = windowWidth;
            baselineHeight = windowHeight;
            closedBottomPadding = -1;
        }
        // Older WebViews get native system-bar padding; newer ones pass safe areas
        // through. Do not subtract IME padding twice or include it in the baseline.
        if (!keyboardVisible && decor.getPaddingBottom() <= bars.bottom) {
            closedBottomPadding = decor.getPaddingBottom();
        }
        int bottomPadding = closedBottomPadding >= 0 ? closedBottomPadding :
            (decor.getPaddingTop() > 0 || decor.getPaddingLeft() > 0 || decor.getPaddingRight() > 0 ? bars.bottom : 0);
        int[] location = new int[2];
        webView.getLocationInWindow(location);
        int layoutHeight = Math.max(1, windowHeight - location[1] - bottomPadding);
        int keyboardTop = keyboardVisible && ime.bottom > 0 ? windowHeight - location[1] - ime.bottom : layoutHeight;
        int visibleHeight = Math.max(1, Math.min(layoutHeight, Math.min(webView.getHeight(), keyboardTop)));
        JSObject viewport = new JSObject();
        viewport.put("layoutWidth", webView.getWidth() / density);
        viewport.put("layoutHeight", layoutHeight / density);
        viewport.put("visibleHeight", visibleHeight / density);
        viewport.put("keyboardInset", keyboardVisible ? Math.max(0, layoutHeight - keyboardTop) / density : 0);
        viewport.put("keyboardVisible", keyboardVisible);
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
        decor = null;
        viewportListener = null;
        super.handleOnDestroy();
    }

    @SuppressWarnings("deprecation")
    private void applyTheme() {
        Window window = getActivity().getWindow();
        int background = Color.parseColor(light ? "#fafbfc" : "#050506");
        window.getDecorView().setBackgroundColor(background);
        window.setStatusBarColor(background);
        window.setNavigationBarColor(background);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(light);
        controller.setAppearanceLightNavigationBars(light);
    }
}
