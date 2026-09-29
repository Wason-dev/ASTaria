#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <UserNotifications/UserNotifications.h>
#import <CoreServices/CoreServices.h>

static BOOL finished = NO;
static void output(NSDictionary *value) {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
        if (data) puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
        finished = YES;
    });
}
static void status(UNUserNotificationCenter *center) {
    [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        [center getPendingNotificationRequestsWithCompletionHandler:^(NSArray<UNNotificationRequest *> *requests) {
            NSUInteger count = 0, withContent = 0;
            for (UNNotificationRequest *request in requests) if ([request.identifier hasPrefix:@"astaria."]) {
                count++;
                if (request.content.title.length && request.content.body.length) withContent++;
            }
            NSString *icon = [NSBundle.mainBundle pathForResource:@"ASTaria" ofType:@"icns"];
            output(@{@"authorization": @(settings.authorizationStatus), @"pending": @(count),
                @"pendingWithContent": @(withContent), @"showPreviews": @(settings.showPreviewsSetting),
                @"iconAvailable": @([NSImage.alloc initWithContentsOfFile:icon ?: @""] != nil)});
        }];
    }];
}
static BOOL stringWithin(id value, NSUInteger limit) { return [value isKindOfClass:NSString.class] && [value length] <= limit; }
static void replace(UNUserNotificationCenter *center) {
    NSData *data = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
    id rows = data.length <= 131072 ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    NSMutableSet *ids = [NSMutableSet set];
    BOOL valid = [rows isKindOfClass:NSArray.class] && [rows count] <= 64;
    NSTimeInterval now = [NSDate date].timeIntervalSince1970;
    if (valid) for (id row in rows) {
        if (![row isKindOfClass:NSDictionary.class]) { valid = NO; break; }
        id identifier = row[@"id"], at = row[@"at"];
        if (!stringWithin(identifier, 100) || ![identifier hasPrefix:@"astaria."] || [ids containsObject:identifier]
            || !stringWithin(row[@"title"], 200) || ![row[@"title"] length]
            || !stringWithin(row[@"body"], 1000) || ![row[@"body"] length] || ![at isKindOfClass:NSNumber.class]
            || !isfinite([at doubleValue]) || [at doubleValue] >= now + 32 * 86400) { valid = NO; break; }
        [ids addObject:identifier];
    }
    if (!valid) { output(@{@"error": @"提醒内容或触发时间无效"}); return; }
    [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        if ([rows count] && settings.authorizationStatus != UNAuthorizationStatusAuthorized && settings.authorizationStatus != UNAuthorizationStatusProvisional) {
            output(@{@"error": @"系统尚未允许通知，请在系统设置中允许 ASTaria 提醒"}); return;
        }
        [center getPendingNotificationRequestsWithCompletionHandler:^(NSArray<UNNotificationRequest *> *previous) {
            dispatch_group_t group = dispatch_group_create(); NSObject *lock = [NSObject new]; __block BOOL failed = NO;
            for (NSDictionary *row in rows) {
                // A request can cross its trigger time while the helper starts.
                // Do not fail the entire batch or schedule an already sent alert again.
                if ([row[@"at"] doubleValue] <= [NSDate date].timeIntervalSince1970) continue;
                UNMutableNotificationContent *content = [UNMutableNotificationContent new];
                content.title = row[@"title"]; content.body = row[@"body"]; content.sound = UNNotificationSound.defaultSound;
                content.categoryIdentifier = @"ASTARIA_REMINDER";
                content.threadIdentifier = @"astaria.schedule";
                NSDate *date = [NSDate dateWithTimeIntervalSince1970:[row[@"at"] doubleValue]];
                NSDateComponents *parts = [NSCalendar.currentCalendar components:(NSCalendarUnitYear | NSCalendarUnitMonth | NSCalendarUnitDay | NSCalendarUnitHour | NSCalendarUnitMinute | NSCalendarUnitSecond) fromDate:date];
                parts.timeZone = NSTimeZone.localTimeZone;
                UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:row[@"id"] content:content trigger:[UNCalendarNotificationTrigger triggerWithDateMatchingComponents:parts repeats:NO]];
                dispatch_group_enter(group);
                [center addNotificationRequest:request withCompletionHandler:^(NSError *error) {
                    if (error) @synchronized(lock) { failed = YES; }
                    dispatch_group_leave(group);
                }];
            }
            dispatch_group_notify(group, dispatch_get_main_queue(), ^{
                if (failed) { output(@{@"error": @"部分提醒未能交给系统，原有提醒仍保留，请重试"}); return; }
                NSMutableArray *remove = [NSMutableArray array];
                for (UNNotificationRequest *request in previous) if ([request.identifier hasPrefix:@"astaria."] && ![ids containsObject:request.identifier]) [remove addObject:request.identifier];
                [center removePendingNotificationRequestsWithIdentifiers:remove];
                output(@{@"scheduled": @([rows count])});
            });
        }];
    }];
}
int main(int argc, const char *argv[]) { @autoreleasepool {
    // This bundled accessory runs directly to schedule reminders after the main
    // App quits. Register its actual bundle before notification authorization so
    // Notification Center can resolve its display name and ICNS after updates.
    LSRegisterURL((__bridge CFURLRef)NSBundle.mainBundle.bundleURL, true);
    [NSApplication.sharedApplication setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSString *icon = [NSBundle.mainBundle pathForResource:@"ASTaria" ofType:@"icns"];
    if (icon) NSApplication.sharedApplication.applicationIconImage = [[NSImage alloc] initWithContentsOfFile:icon];
    UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
    UNNotificationCategory *category = [UNNotificationCategory categoryWithIdentifier:@"ASTARIA_REMINDER" actions:@[] intentIdentifiers:@[]
        hiddenPreviewsBodyPlaceholder:@"打开 ASTaria 查看提醒" categorySummaryFormat:@"%u 条待办提醒" options:UNNotificationCategoryOptionNone];
    [center setNotificationCategories:[NSSet setWithObject:category]];
    NSString *command = argc > 1 ? [NSString stringWithUTF8String:argv[1]] : @"status";
    if ([command isEqualToString:@"authorize"]) {
        [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound) completionHandler:^(BOOL granted, NSError *error) {
            if (error) output(@{@"error": @"无法申请系统提醒权限，请在系统设置中检查通知权限"}); else status(center);
        }];
    } else if ([command isEqualToString:@"test"]) {
        UNMutableNotificationContent *content = [UNMutableNotificationContent new];
        content.title = @"ASTaria 提醒测试";
        content.body = @"这是一条测试提醒。事项名称和开始或截止时间会显示在这里。";
        content.categoryIdentifier = @"ASTARIA_REMINDER";
        content.sound = UNNotificationSound.defaultSound;
        UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:@"astaria.test" content:content
            trigger:[UNTimeIntervalNotificationTrigger triggerWithTimeInterval:5 repeats:NO]];
        [center addNotificationRequest:request withCompletionHandler:^(NSError *error) {
            output(error ? @{@"error": @"测试提醒未能交给系统，请检查通知权限"} : @{@"scheduled": @1});
        }];
    } else if ([command isEqualToString:@"status"]) status(center);
    else if ([command isEqualToString:@"replace"]) replace(center);
    else output(@{@"error": @"未知提醒操作"});
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:[command isEqualToString:@"authorize"] ? 90 : 15];
    while (!finished && deadline.timeIntervalSinceNow > 0) [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
    if (!finished) { puts("{\"error\":\"系统提醒服务暂未响应，请稍后重试\"}"); return 1; }
    return 0;
} }
