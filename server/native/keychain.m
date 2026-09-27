#import <Foundation/Foundation.h>
#import <Security/Security.h>

// Secret input/output uses private pipes, never argv or a plaintext file.
static void output(NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    if (data) [[NSFileHandle fileHandleWithStandardOutput] writeData:data];
}
int main(void) {
    @autoreleasepool {
        NSData *input = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
        id request = [NSJSONSerialization JSONObjectWithData:input options:0 error:nil];
        if (![request isKindOfClass:[NSDictionary class]]) { output(@{@"ok": @NO}); return 1; }
        NSString *action = request[@"action"];
        NSDictionary *query = @{(__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
                                (__bridge id)kSecAttrService: @"dev.wason.ASTaria.deepseek",
                                (__bridge id)kSecAttrAccount: @"api-key"};
        if ([action isEqualToString:@"status"]) {
            NSMutableDictionary *check = [query mutableCopy];
            check[(__bridge id)kSecReturnAttributes] = @YES;
            CFTypeRef result = NULL;
            OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)check, &result);
            if (result) CFRelease(result);
            output(@{@"ok": @(status == errSecSuccess || status == errSecItemNotFound), @"configured": @(status == errSecSuccess)});
        } else if ([action isEqualToString:@"save"]) {
            id key = request[@"key"];
            if (![key isKindOfClass:[NSString class]] || [key length] == 0 || [key length] > 512) { output(@{@"ok": @NO}); return 1; }
            NSData *data = [key dataUsingEncoding:NSUTF8StringEncoding];
            NSDictionary *attributes = @{(__bridge id)kSecValueData: data};
            OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)query, (__bridge CFDictionaryRef)attributes);
            if (status == errSecItemNotFound) {
                NSMutableDictionary *item = [query mutableCopy];
                item[(__bridge id)kSecValueData] = data;
                item[(__bridge id)kSecAttrLabel] = @"ASTaria · DeepSeek API Key";
                item[(__bridge id)kSecAttrAccessible] = (__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly;
                item[(__bridge id)kSecAttrSynchronizable] = @NO;
                status = SecItemAdd((__bridge CFDictionaryRef)item, NULL);
            }
            output(@{@"ok": @(status == errSecSuccess)});
        } else if ([action isEqualToString:@"get"]) {
            NSMutableDictionary *read = [query mutableCopy];
            read[(__bridge id)kSecReturnData] = @YES;
            CFTypeRef result = NULL;
            OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)read, &result);
            NSData *data = CFBridgingRelease(result);
            NSString *key = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
            output(status == errSecSuccess && key ? @{@"ok": @YES, @"key": key} : @{@"ok": @NO});
        } else if ([action isEqualToString:@"remove"]) {
            OSStatus status = SecItemDelete((__bridge CFDictionaryRef)query);
            output(@{@"ok": @(status == errSecSuccess || status == errSecItemNotFound)});
        } else { output(@{@"ok": @NO}); return 1; }
    }
    return 0;
}
