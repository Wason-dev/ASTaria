// Exercise the shipped native reconciliation code against an in-memory center.
// No UNUserNotificationCenter instance, authorization request or real alert.
#define main astaria_reminders_main
#include "../../desktop/native/reminders.m"
#undef main

@interface TestSettings : NSObject
@property(nonatomic, readonly) UNAuthorizationStatus authorizationStatus;
@end
@implementation TestSettings
- (UNAuthorizationStatus)authorizationStatus { return UNAuthorizationStatusAuthorized; }
@end

@interface TestCenter : NSObject
@property(nonatomic, strong) NSMutableDictionary *requests;
@property(nonatomic, strong) NSMutableArray *removed;
@property(nonatomic, strong) NSMutableArray *calls;
@property(nonatomic, strong) NSArray *failIds;
@end
@implementation TestCenter
- (void)getNotificationSettingsWithCompletionHandler:(void (^)(UNNotificationSettings *))completion {
    completion((UNNotificationSettings *)[TestSettings new]);
}
- (void)getPendingNotificationRequestsWithCompletionHandler:(void (^)(NSArray<UNNotificationRequest *> *))completion {
    [self.calls addObject:@"read"];
    completion(self.requests.allValues);
}
- (void)removePendingNotificationRequestsWithIdentifiers:(NSArray<NSString *> *)ids {
    for (NSString *identifier in ids) {
        [self.calls addObject:[@"remove:" stringByAppendingString:identifier]];
        [self.removed addObject:identifier]; [self.requests removeObjectForKey:identifier];
    }
}
- (void)addNotificationRequest:(UNNotificationRequest *)request withCompletionHandler:(void (^)(NSError *))completion {
    [self.calls addObject:[@"add:" stringByAppendingString:request.identifier]];
    if ([self.failIds containsObject:request.identifier]) completion([NSError errorWithDomain:@"test" code:1 userInfo:nil]);
    else { self.requests[request.identifier] = request; completion(nil); }
}
@end

int main(int argc, const char *argv[]) { @autoreleasepool {
    NSDictionary *fixture = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:argv[1]] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    TestCenter *center = [TestCenter new];
    center.requests = [NSMutableDictionary dictionary]; center.removed = [NSMutableArray array]; center.calls = [NSMutableArray array];
    center.failIds = fixture[@"failIds"] ?: @[];
    for (NSDictionary *row in fixture[@"previous"]) {
        UNMutableNotificationContent *content = [UNMutableNotificationContent new]; content.title = row[@"title"]; content.body = row[@"body"];
        NSDate *date = [NSDate dateWithTimeIntervalSince1970:[row[@"at"] doubleValue]];
        NSDateComponents *parts = [NSCalendar.currentCalendar components:(NSCalendarUnitYear | NSCalendarUnitMonth | NSCalendarUnitDay | NSCalendarUnitHour | NSCalendarUnitMinute | NSCalendarUnitSecond) fromDate:date];
        parts.timeZone = NSTimeZone.localTimeZone;
        center.requests[row[@"id"]] = [UNNotificationRequest requestWithIdentifier:row[@"id"] content:content trigger:[UNCalendarNotificationTrigger triggerWithDateMatchingComponents:parts repeats:NO]];
    }
    replace((UNUserNotificationCenter *)center);
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:3];
    while (!finished && deadline.timeIntervalSinceNow > 0) [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    if (!finished) return 2;
    NSMutableArray *entries = [NSMutableArray array];
    for (UNNotificationRequest *request in center.requests.allValues) [entries addObject:entry(request)];
    NSData *data = [NSJSONSerialization dataWithJSONObject:@{@"entries": entries, @"removed": center.removed, @"calls": center.calls} options:0 error:nil];
    puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
    return 0;
} }
