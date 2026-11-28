#include <napi.h>
#include <windows.h>
#include <userconsentverifierinterop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Security.Credentials.UI.h>
#include <cstring>

using namespace winrt::Windows::Foundation;
using namespace winrt::Windows::Security::Credentials::UI;

namespace {
class Apartment {
public:
    Apartment() { winrt::init_apartment(winrt::apartment_type::multi_threaded); }
    ~Apartment() { winrt::uninit_apartment(); }
};

// The UI is owned by Windows Hello. The worker only reports its enum result and
// handles no credentials, PIN data, biometric templates or credential handles.
class ConsentWorker final : public Napi::AsyncWorker {
public:
    ConsentWorker(Napi::Env env, HWND owner, bool checkOnly) : Napi::AsyncWorker(env),
        deferred(Napi::Promise::Deferred::New(env)), owner(owner), checkOnly(checkOnly) {}
    Napi::Promise promise() { return deferred.Promise(); }
    void Execute() override {
        try {
            Apartment apartment;
            const auto availability = UserConsentVerifier::CheckAvailabilityAsync().get();
            auto interop = winrt::try_get_activation_factory<UserConsentVerifier, IUserConsentVerifierInterop>();
            if (!interop || availability != UserConsentVerifierAvailability::Available) return;
            if (checkOnly) { success = true; return; }
            DWORD process = 0;
            if (!IsWindow(owner) || !IsWindowVisible(owner) || !GetWindowThreadProcessId(owner, &process) || process != GetCurrentProcessId()) return;
            winrt::hstring message{ L"解锁 Brclio 终端" };
            IAsyncOperation<UserConsentVerificationResult> operation{nullptr};
            winrt::check_hresult(interop->RequestVerificationForWindowAsync(owner,
                reinterpret_cast<HSTRING>(winrt::get_abi(message)), winrt::guid_of<decltype(operation)>(), winrt::put_abi(operation)));
            success = operation.get() == UserConsentVerificationResult::Verified;
        } catch (...) { success = false; }
    }
    void OnOK() override { deferred.Resolve(Napi::Boolean::New(Env(), success)); }
    void OnError(const Napi::Error&) override { deferred.Resolve(Napi::Boolean::New(Env(), false)); }
private:
    Napi::Promise::Deferred deferred;
    HWND owner;
    bool checkOnly;
    bool success = false;
};

Napi::Value run(const Napi::CallbackInfo& info, bool availability) {
    HWND owner = nullptr;
    if (!availability) {
        if (info.Length() != 1 || !info[0].IsBuffer()) throw Napi::TypeError::New(info.Env(), "A native window handle is required");
        auto handle = info[0].As<Napi::Buffer<unsigned char>>();
        if (handle.Length() != sizeof(owner)) throw Napi::TypeError::New(info.Env(), "Invalid native window handle");
        std::memcpy(&owner, handle.Data(), sizeof(owner));
    }
    auto worker = new ConsentWorker(info.Env(), owner, availability);
    auto promise = worker->promise();
    worker->Queue();
    return promise;
}
Napi::Object initialize(Napi::Env env, Napi::Object exports) {
    exports.Set("available", Napi::Function::New(env, [](const Napi::CallbackInfo& info) { return run(info, true); }));
    exports.Set("verify", Napi::Function::New(env, [](const Napi::CallbackInfo& info) { return run(info, false); }));
    return exports;
}
}
NODE_API_MODULE(brclio_hello, initialize)
