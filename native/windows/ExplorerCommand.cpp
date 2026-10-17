// A packaged COM surrogate hosts this DLL; no Electron or CRT redistributable
// is loaded into Explorer. All selected paths go to one Brclio invocation.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <servprov.h>
#include <wrl/client.h>
#include <atomic>
#include <cstring>
#include <new>
#include <utility>
#include "CommandLine.h"

using Microsoft::WRL::ComPtr;

namespace {
// Also declared in AppxManifest.xml.in. Keep this identity stable across updates.
constexpr CLSID CommandClass = {0xcfd1e4d4, 0x3973, 0x45d3,
                               {0x85, 0x42, 0x45, 0xa7, 0x7e, 0x6c, 0x58, 0xc9}};
constexpr wchar_t MenuTitle[] = L"复制路径 · Brclio";
HMODULE moduleHandle = nullptr;
std::atomic<long> liveObjects{0};
std::atomic<long> serverLocks{0};

HRESULT Duplicate(const wchar_t* value, PWSTR* output) noexcept {
    if (!output) return E_POINTER;
    *output = nullptr;
    const size_t bytes = (wcslen(value) + 1) * sizeof(wchar_t);
    auto duplicate = static_cast<PWSTR>(CoTaskMemAlloc(bytes));
    if (!duplicate) return E_OUTOFMEMORY;
    memcpy(duplicate, value, bytes);
    *output = duplicate;
    return S_OK;
}

HRESULT ExecutablePath(std::wstring& executable, std::wstring& directory) {
    std::vector<wchar_t> buffer(32768);
    const DWORD length = GetModuleFileNameW(moduleHandle, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (!length) return HRESULT_FROM_WIN32(GetLastError());
    if (length >= buffer.size()) return HRESULT_FROM_WIN32(ERROR_FILENAME_EXCED_RANGE);
    directory.assign(buffer.data(), length);
    // <install>\resources\windows-shell\<package-version>\BrclioExplorerCommand.dll
    for (int component = 0; component < 4; ++component) {
        const auto slash = directory.find_last_of(L"\\/");
        if (slash == std::wstring::npos) return E_UNEXPECTED;
        directory.resize(slash == 2 && directory[1] == L':' ? 3 : slash);
    }
    executable = directory + (directory.back() == L'\\' ? L"Brclio.exe" : L"\\Brclio.exe");
    return S_OK;
}

HRESULT FilesystemPath(IShellItem* item, std::wstring& path) {
    if (!item) return E_POINTER;
    PWSTR raw = nullptr;
    const HRESULT result = item->GetDisplayName(SIGDN_FILESYSPATH, &raw);
    if (FAILED(result)) return result;
    if (!raw) return E_UNEXPECTED;
    // Own the COM allocation even if std::wstring allocation throws.
    struct FreeString { PWSTR value; ~FreeString() { CoTaskMemFree(value); } } allocation{raw};
    path.assign(raw);
    return path.empty() ? E_INVALIDARG : S_OK;
}

HRESULT CurrentFolder(IUnknown* site, ComPtr<IShellItem>& item) {
    if (!site) return E_FAIL;
    ComPtr<IFolderView> view;
    HRESULT result = site->QueryInterface(IID_PPV_ARGS(&view));
    if (FAILED(result)) {
        result = IUnknown_QueryService(site, SID_SFolderView, IID_PPV_ARGS(&view));
    }
    if (FAILED(result)) {
        // Some site chains expose the browser's active IShellView instead.
        ComPtr<IShellBrowser> browser;
        result = IUnknown_QueryService(site, SID_STopLevelBrowser, IID_PPV_ARGS(&browser));
        if (FAILED(result)) return result;
        ComPtr<IShellView> shellView;
        result = browser->QueryActiveShellView(&shellView);
        if (FAILED(result)) return result;
        result = shellView.As(&view);
        if (FAILED(result)) return result;
    }
    // The folder object is usually IShellFolder/IPersistFolder2, rather than
    // IShellItem. Convert its absolute PIDL without parsing display-name text.
    ComPtr<IPersistFolder2> folder;
    result = view->GetFolder(IID_PPV_ARGS(&folder));
    if (FAILED(result)) return result;
    PIDLIST_ABSOLUTE id = nullptr;
    result = folder->GetCurFolder(&id);
    if (FAILED(result)) return result;
    if (!id) return E_UNEXPECTED;
    result = SHCreateItemFromIDList(id, IID_PPV_ARGS(&item));
    CoTaskMemFree(id);
    return result;
}

class ExplorerCommand final : public IExplorerCommand, public IObjectWithSite {
public:
    ExplorerCommand() noexcept { ++liveObjects; }
    ~ExplorerCommand() { --liveObjects; }

    IFACEMETHODIMP QueryInterface(REFIID iid, void** output) override {
        if (!output) return E_POINTER;
        *output = nullptr;
        if (iid == IID_IUnknown || iid == IID_IExplorerCommand) {
            *output = static_cast<IExplorerCommand*>(this);
        } else if (iid == IID_IObjectWithSite) {
            *output = static_cast<IObjectWithSite*>(this);
        } else {
            return E_NOINTERFACE;
        }
        AddRef();
        return S_OK;
    }
    IFACEMETHODIMP_(ULONG) AddRef() override { return ++references_; }
    IFACEMETHODIMP_(ULONG) Release() override {
        const ULONG remaining = --references_;
        if (!remaining) delete this;
        return remaining;
    }
    IFACEMETHODIMP GetTitle(IShellItemArray*, PWSTR* title) override {
        return Duplicate(MenuTitle, title);
    }
    IFACEMETHODIMP GetIcon(IShellItemArray*, PWSTR* icon) override {
        if (!icon) return E_POINTER;
        *icon = nullptr;
        try {
            std::wstring executable, directory;
            const HRESULT result = ExecutablePath(executable, directory);
            if (FAILED(result)) return result;
            return Duplicate((executable + L",0").c_str(), icon);
        } catch (const std::bad_alloc&) { return E_OUTOFMEMORY; }
        catch (...) { return E_FAIL; }
    }
    IFACEMETHODIMP GetToolTip(IShellItemArray*, PWSTR* tooltip) override {
        return Duplicate(MenuTitle, tooltip);
    }
    IFACEMETHODIMP GetCanonicalName(GUID* name) override {
        if (!name) return E_POINTER;
        *name = CommandClass;
        return S_OK;
    }
    IFACEMETHODIMP GetState(IShellItemArray* selection, BOOL, EXPCMDSTATE* state) override {
        if (!state) return E_POINTER;
        *state = ECS_HIDDEN;
        DWORD count = 0;
        if (selection) {
            const HRESULT result = selection->GetCount(&count);
            if (FAILED(result)) return result;
        }
        if (count > brclio::MaxSelection) {
            *state = ECS_DISABLED;
            return S_OK;
        }
        SFGAOF attributes = 0;
        if (count) {
            // Do not enumerate names, touch file content, or launch the app on
            // Explorer's menu-construction path. Virtual items stay hidden.
            if (SUCCEEDED(selection->GetAttributes(SIATTRIBFLAGS_AND, SFGAO_FILESYSTEM, &attributes)) &&
                (attributes & SFGAO_FILESYSTEM)) *state = ECS_ENABLED;
        } else {
            ComPtr<IShellItem> folder;
            if (SUCCEEDED(CurrentFolder(site_.Get(), folder)) &&
                SUCCEEDED(folder->GetAttributes(SFGAO_FILESYSTEM, &attributes)) &&
                (attributes & SFGAO_FILESYSTEM)) *state = ECS_ENABLED;
        }
        return S_OK;
    }
    IFACEMETHODIMP Invoke(IShellItemArray* selection, IBindCtx*) override {
        try {
            DWORD count = 0;
            if (selection) {
                const HRESULT result = selection->GetCount(&count);
                if (FAILED(result)) return result;
            }
            if (count > brclio::MaxSelection) return E_INVALIDARG;
            std::vector<std::wstring> paths;
            paths.reserve(count ? count : 1);
            if (count) {
                for (DWORD index = 0; index < count; ++index) {
                    ComPtr<IShellItem> item;
                    HRESULT result = selection->GetItemAt(index, &item);
                    if (FAILED(result)) return result;
                    std::wstring path;
                    result = FilesystemPath(item.Get(), path);
                    if (FAILED(result)) return result;
                    paths.push_back(std::move(path));
                }
            } else {
                ComPtr<IShellItem> folder;
                HRESULT result = CurrentFolder(site_.Get(), folder);
                if (FAILED(result)) return result;
                std::wstring path;
                result = FilesystemPath(folder.Get(), path);
                if (FAILED(result)) return result;
                paths.push_back(std::move(path));
            }
            std::wstring executable, directory;
            HRESULT result = ExecutablePath(executable, directory);
            if (FAILED(result)) return result;
            std::wstring command = brclio::BuildCommandLine(executable, paths);
            STARTUPINFOW startup{};
            startup.cb = sizeof(startup);
            PROCESS_INFORMATION process{};
            if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE,
                                CREATE_NO_WINDOW, nullptr, directory.c_str(), &startup, &process)) {
                return HRESULT_FROM_WIN32(GetLastError());
            }
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            return S_OK;
        } catch (const std::bad_alloc&) { return E_OUTOFMEMORY; }
        catch (const std::length_error&) { return HRESULT_FROM_WIN32(ERROR_FILENAME_EXCED_RANGE); }
        catch (const std::invalid_argument&) { return E_INVALIDARG; }
        catch (...) { return E_FAIL; }
    }
    IFACEMETHODIMP GetFlags(EXPCMDFLAGS* flags) override {
        if (!flags) return E_POINTER;
        *flags = ECF_DEFAULT;
        return S_OK;
    }
    IFACEMETHODIMP EnumSubCommands(IEnumExplorerCommand** commands) override {
        if (!commands) return E_POINTER;
        *commands = nullptr;
        return E_NOTIMPL;
    }
    IFACEMETHODIMP SetSite(IUnknown* site) override {
        site_ = site;
        return S_OK;
    }
    IFACEMETHODIMP GetSite(REFIID iid, void** output) override {
        if (!output) return E_POINTER;
        *output = nullptr;
        return site_ ? site_->QueryInterface(iid, output) : E_FAIL;
    }
private:
    std::atomic<ULONG> references_{1};
    ComPtr<IUnknown> site_;
};

class ClassFactory final : public IClassFactory {
public:
    ClassFactory() noexcept { ++liveObjects; }
    ~ClassFactory() { --liveObjects; }
    IFACEMETHODIMP QueryInterface(REFIID iid, void** output) override {
        if (!output) return E_POINTER;
        *output = nullptr;
        if (iid != IID_IUnknown && iid != IID_IClassFactory) return E_NOINTERFACE;
        *output = static_cast<IClassFactory*>(this);
        AddRef();
        return S_OK;
    }
    IFACEMETHODIMP_(ULONG) AddRef() override { return ++references_; }
    IFACEMETHODIMP_(ULONG) Release() override {
        const ULONG remaining = --references_;
        if (!remaining) delete this;
        return remaining;
    }
    IFACEMETHODIMP CreateInstance(IUnknown* outer, REFIID iid, void** output) override {
        if (!output) return E_POINTER;
        *output = nullptr;
        if (outer) return CLASS_E_NOAGGREGATION;
        auto command = new (std::nothrow) ExplorerCommand();
        if (!command) return E_OUTOFMEMORY;
        const HRESULT result = command->QueryInterface(iid, output);
        command->Release();
        return result;
    }
    IFACEMETHODIMP LockServer(BOOL lock) override {
        if (lock) ++serverLocks;
        else --serverLocks;
        return S_OK;
    }
private:
    std::atomic<ULONG> references_{1};
};
} // namespace

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) moduleHandle = instance;
    return TRUE;
}

STDAPI DllCanUnloadNow() {
    return liveObjects == 0 && serverLocks == 0 ? S_OK : S_FALSE;
}

STDAPI DllGetClassObject(REFCLSID clsid, REFIID iid, void** output) {
    if (!output) return E_POINTER;
    *output = nullptr;
    if (clsid != CommandClass) return CLASS_E_CLASSNOTAVAILABLE;
    auto factory = new (std::nothrow) ClassFactory();
    if (!factory) return E_OUTOFMEMORY;
    const HRESULT result = factory->QueryInterface(iid, output);
    factory->Release();
    return result;
}
