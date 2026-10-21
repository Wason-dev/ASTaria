import Capacitor

final class ViewController: CAPBridgeViewController {
    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        // Capacitor debug logging can include plugin arguments/results containing the key.
        descriptor.loggingBehavior = .none
        return descriptor
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(ASTariaSecretsPlugin())
    }
}
