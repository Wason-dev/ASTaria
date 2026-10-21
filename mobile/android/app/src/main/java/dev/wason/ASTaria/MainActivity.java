package dev.wason.ASTaria;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;

public class MainActivity extends BridgeActivity {
    @Override
    @SuppressWarnings("deprecation")
    protected void onCreate(Bundle savedInstanceState) {
        // This public Capacitor 8 constructor preserves the packaged configuration.
        // The logging override applies before Bridge creation, including debug builds.
        config = new CapConfig(getAssets(), null) {
            @Override
            public boolean isLoggingEnabled() {
                return false;
            }
        };
        registerPlugin(ASTariaSecretsPlugin.class);
        registerPlugin(ASTariaAppearancePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
