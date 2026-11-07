#import <AppKit/AppKit.h>
#import <dispatch/dispatch.h>
#import "_cgo_export.h"

@interface BrclioLiteDelegate : NSObject <NSApplicationDelegate>
@end

// Only accessed on the AppKit main thread.
static BOOL pendingSystemQuit;

@implementation BrclioLiteDelegate
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    liteDidFinishLaunching();
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)application hasVisibleWindows:(BOOL)hasWindows {
    liteReopen();
    return NO;
}

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)application {
    if (!liteRequestQuit()) return NSTerminateCancel;
    pendingSystemQuit = YES;
    return NSTerminateLater;
}
@end

void runLiteApplication(void) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        BrclioLiteDelegate *delegate = [[BrclioLiteDelegate alloc] init];
        app.delegate = delegate;
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        [app run];
        app.delegate = nil;
        [delegate release];
    }
}

void stopLiteApplication(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (pendingSystemQuit) {
            [NSApp replyToApplicationShouldTerminate:YES];
            return;
        }
        [NSApp stop:nil];
        // Wake the event loop even when the browser is the frontmost application.
        NSEvent *wake = [NSEvent otherEventWithType:NSEventTypeApplicationDefined
            location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:0 context:nil
            subtype:0 data1:0 data2:0];
        [NSApp postEvent:wake atStart:NO];
    });
}
