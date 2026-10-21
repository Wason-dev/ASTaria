#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>

// Finder keeps the real, accessible text-file label; only the decorative
// document thumbnail is transparent. This modifies the staging volume only.
int main(int argc, const char **argv) { @autoreleasepool {
    if (argc != 2) return 1;
    NSString *path = [[NSString stringWithUTF8String:argv[1]] stringByAppendingPathComponent:@"安装与打开说明.txt"];
    if (![NSFileManager.defaultManager fileExistsAtPath:path]) return 2;
    NSImage *image = [[NSImage alloc] initWithSize:NSMakeSize(32, 32)];
    [image lockFocus];
    [[NSColor clearColor] set]; NSRectFillUsingOperation(NSMakeRect(0, 0, 32, 32), NSCompositingOperationCopy);
    [image unlockFocus];
    return [NSWorkspace.sharedWorkspace setIcon:image forFile:path options:0] ? 0 : 3;
} }
