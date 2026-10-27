import UIKit
import Capacitor
import WebKit

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    override func buildMenu(with builder: UIMenuBuilder) {
        super.buildMenu(with: builder)
        guard builder.system == .main, UIDevice.current.userInterfaceIdiom == .pad else { return }
        func command(_ title: String, _ key: String, _ value: String, _ flags: UIKeyModifierFlags = .command) -> UIKeyCommand {
            UIKeyCommand(title: title, action: #selector(runASTariaCommand(_:)), input: key,
                         modifierFlags: flags, propertyList: value)
        }
        builder.insertChild(UIMenu(title: "", identifier: UIMenu.Identifier("dev.wason.astaria.conversation"), options: .displayInline, children: [
            command("新建对话", "n", "new-conversation", [.command, .shift])
        ]), atStartOfMenu: .file)
        builder.insertChild(UIMenu(title: "前往", identifier: UIMenu.Identifier("dev.wason.astaria.navigation"), options: .displayInline, children: [
            command("首页", "1", "home"), command("工作台", "2", "workbench"),
            command("日程", "3", "schedule"), command("余时", "4", "free-time"),
            command("设置", ",", "settings"), command("展开 / 收起析熙", "l", "toggle-chat")
        ]), atStartOfMenu: .view)
        builder.insertChild(UIMenu(title: "", identifier: UIMenu.Identifier("dev.wason.astaria.help"), options: .displayInline, children: [
            UICommand(title: "ASTaria 官网与使用说明", action: #selector(openASTariaHelp))
        ]), atStartOfMenu: .help)
    }

    @objc private func runASTariaCommand(_ command: UICommand) {
        guard let action = command.propertyList as? String,
              ["new-conversation", "home", "workbench", "schedule", "free-time", "settings", "toggle-chat"].contains(action),
              let scene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene,
              let controller = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController as? CAPBridgeViewController else { return }
        controller.webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('astaria-native-menu',{detail:'\(action)'}))", completionHandler: nil)
    }

    @objc private func openASTariaHelp() {
        UIApplication.shared.open(URL(string: "https://astaria.space")!)
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
