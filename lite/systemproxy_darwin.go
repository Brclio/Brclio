package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Foundation -framework CFNetwork -framework CoreFoundation
#import <Foundation/Foundation.h>
#import <CFNetwork/CFNetwork.h>
#include <stdlib.h>

struct PacResult { CFArrayRef proxies; int done; };
static void pacResult(void *state, CFArrayRef proxies, CFErrorRef error) {
	struct PacResult *r = state;
	if (!error && proxies) r->proxies = CFRetain(proxies);
	r->done = 1;
}
static char *systemProxy(const char *target) {
	@autoreleasepool {
		NSURL *dest = [NSURL URLWithString:[NSString stringWithUTF8String:target]];
		if (!dest) return NULL;
		CFDictionaryRef settings = CFNetworkCopySystemProxySettings();
		if (!settings) return NULL;
		CFArrayRef list = CFNetworkCopyProxiesForURL((CFURLRef)dest, settings);
		CFRelease(settings);
		if (!list) return NULL;
		char *result = NULL;
		for (int round = 0; round < 2 && CFArrayGetCount(list); round++) {
			NSDictionary *proxy = [(NSArray *)list objectAtIndex:0];
			NSString *type = [proxy objectForKey:(NSString *)kCFProxyTypeKey];
			if ([type isEqual:(NSString *)kCFProxyTypeNone]) { result = strdup(""); break; }
			if ([type isEqual:(NSString *)kCFProxyTypeAutoConfigurationURL] && round == 0) {
				struct PacResult response = {NULL,0};
				CFStreamClientContext context = {0,&response,NULL,NULL,NULL};
				CFURLRef pac = (CFURLRef)[proxy objectForKey:(NSString *)kCFProxyAutoConfigurationURLKey];
				CFRunLoopSourceRef src = pac ? CFNetworkExecuteProxyAutoConfigurationURL(pac,(CFURLRef)dest,pacResult,&context) : NULL;
				if (!src) break;
				CFRunLoopRef loop = CFRunLoopGetCurrent();
				CFStringRef mode = CFSTR("BrclioLitePAC");
				CFRunLoopAddSource(loop,src,mode);
				CFAbsoluteTime until = CFAbsoluteTimeGetCurrent()+5;
				while (!response.done && CFAbsoluteTimeGetCurrent()<until) CFRunLoopRunInMode(mode,0.25,true);
				CFRunLoopRemoveSource(loop,src,mode); CFRunLoopSourceInvalidate(src); CFRelease(src);
				if (!response.proxies) break;
				CFRelease(list); list=response.proxies; continue;
			}
			if ([type isEqual:(NSString *)kCFProxyTypeAutoConfigurationJavaScript] && round == 0) {
				CFStringRef script = (CFStringRef)[proxy objectForKey:(NSString *)kCFProxyAutoConfigurationJavaScriptKey];
				CFArrayRef pacList = script ? CFNetworkCopyProxiesForAutoConfigurationScript(script,(CFURLRef)dest,NULL) : NULL;
				if (!pacList) break;
				CFRelease(list); list = pacList; continue;
			}
			NSString *host = [proxy objectForKey:(NSString *)kCFProxyHostNameKey];
			NSNumber *port = [proxy objectForKey:(NSString *)kCFProxyPortNumberKey];
			NSString *scheme = [type isEqual:(NSString *)kCFProxyTypeSOCKS] ? @"socks5" :
				([type isEqual:(NSString *)kCFProxyTypeHTTP] || [type isEqual:(NSString *)kCFProxyTypeHTTPS]) ? @"http" : nil;
			if (!scheme || !host.length || !port.intValue) break;
			NSURLComponents *url = [[NSURLComponents alloc] init];
			url.scheme=scheme; url.host=host; url.port=port;
			if (url.string.UTF8String) result=strdup(url.string.UTF8String);
			[url release]; break;
		}
		CFRelease(list); return result;
	}
}
*/
import "C"
import (
	"context"
	"errors"
	"unsafe"
)

func platformProxy(ctx context.Context, target string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	s := C.CString(target)
	defer C.free(unsafe.Pointer(s))
	value := C.systemProxy(s)
	if value == nil {
		return "", errors.New("system proxy lookup failed")
	}
	defer C.free(unsafe.Pointer(value))
	return C.GoString(value), nil
}
