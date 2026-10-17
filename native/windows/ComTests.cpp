// Loads the real DLL and exercises COM/selection dispatch without modifying any
// package, registry, trust store, or Explorer process. The same executable acts
// as a fake Brclio child to record CreateProcessW's real Unicode argv.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <servprov.h>
#include <wrl/client.h>
#include <atomic>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {
constexpr CLSID CommandClass = {0xcfd1e4d4, 0x3973, 0x45d3,
                               {0x85, 0x42, 0x45, 0xa7, 0x7e, 0x6c, 0x58, 0xc9}};

void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}
void success(HRESULT result, const char* message) { require(SUCCEEDED(result), message); }

std::wstring LongPath(const std::wstring& value) {
    const DWORD size = GetLongPathNameW(value.c_str(), nullptr, 0);
    require(size > 0, "Cannot resolve the existing fixture's long path");
    std::wstring result(size, L'\0');
    const DWORD length = GetLongPathNameW(value.c_str(), result.data(), size);
    require(length > 0 && length < size, "Cannot read the existing fixture's long path");
    result.resize(length);
    return result;
}

std::string Utf8(const std::wstring& value) {
    const int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    require(length > 0, "Cannot encode fixture path diagnostics");
    std::string result(static_cast<size_t>(length), '\0');
    require(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), result.data(), length, nullptr, nullptr) == length,
        "Cannot write fixture path diagnostics");
    return result;
}

std::wstring Environment(const wchar_t* key) {
    const DWORD size = GetEnvironmentVariableW(key, nullptr, 0);
    if (!size) return {};
    std::wstring value(size, L'\0');
    const DWORD length = GetEnvironmentVariableW(key, value.data(), size);
    require(length > 0 && length < size, "Cannot read test environment");
    value.resize(length);
    return value;
}

void WriteArguments(const std::wstring& filename, int count, wchar_t** arguments) {
    std::vector<unsigned char> output;
    for (int index = 1; index < count; ++index) {
        const auto length = static_cast<DWORD>(wcslen(arguments[index]));
        const auto bytes = reinterpret_cast<const unsigned char*>(&length);
        output.insert(output.end(), bytes, bytes + sizeof(length));
        const auto value = reinterpret_cast<const unsigned char*>(arguments[index]);
        output.insert(output.end(), value, value + length * sizeof(wchar_t));
    }
    const HANDLE file = CreateFileW(filename.c_str(), GENERIC_WRITE, 0, nullptr,
                                    CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    require(file != INVALID_HANDLE_VALUE, "Cannot open child argument record");
    DWORD written = 0;
    const BOOL complete = WriteFile(file, output.data(), static_cast<DWORD>(output.size()), &written, nullptr);
    CloseHandle(file);
    require(complete && written == output.size(), "Cannot write child argument record");
}

std::vector<std::wstring> ReadArguments(const std::wstring& filename, size_t expectedCount) {
    for (int attempt = 0; attempt < 200; ++attempt) {
        const HANDLE file = CreateFileW(filename.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                                        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (file != INVALID_HANDLE_VALUE) {
            const DWORD size = GetFileSize(file, nullptr);
            std::vector<unsigned char> bytes(size);
            DWORD read = 0;
            const BOOL complete = ReadFile(file, bytes.data(), size, &read, nullptr);
            CloseHandle(file);
            if (complete && read == size) {
                std::vector<std::wstring> arguments;
                size_t position = 0;
                while (position + sizeof(DWORD) <= bytes.size()) {
                    DWORD length = 0;
                    memcpy(&length, bytes.data() + position, sizeof(length));
                    position += sizeof(length);
                    if (length > (bytes.size() - position) / sizeof(wchar_t)) break;
                    std::wstring value(length, L'\0');
                    memcpy(value.data(), bytes.data() + position, length * sizeof(wchar_t));
                    arguments.push_back(value);
                    position += length * sizeof(wchar_t);
                }
                if (arguments.size() == expectedCount && position == bytes.size()) return arguments;
            }
        }
        Sleep(25);
    }
    throw std::runtime_error("Brclio child did not record expected arguments");
}

ComPtr<IShellItemArray> Selection(const std::vector<std::wstring>& paths) {
    std::vector<PIDLIST_ABSOLUTE> identifiers;
    struct FreeIds {
        std::vector<PIDLIST_ABSOLUTE>& values;
        ~FreeIds() { for (auto id : values) CoTaskMemFree(id); }
    } cleanup{identifiers};
    for (const auto& path : paths) {
        PIDLIST_ABSOLUTE id = nullptr;
        success(SHParseDisplayName(path.c_str(), nullptr, &id, 0, nullptr), "Cannot parse selection path");
        identifiers.push_back(id);
    }
    ComPtr<IShellItemArray> selection;
    // This SDK declares the array as LPCITEMIDLIST*, whose pointer slots are
    // mutable even though each referenced ITEMIDLIST is read-only.
    std::vector<LPCITEMIDLIST> readonlyIds;
    readonlyIds.reserve(identifiers.size());
    for (auto id : identifiers) readonlyIds.push_back(reinterpret_cast<LPCITEMIDLIST>(id));
    success(SHCreateShellItemArrayFromIDLists(static_cast<UINT>(identifiers.size()),
        readonlyIds.data(), &selection), "Cannot create shell selection");
    return selection;
}

// Only GetFolder is used; the other methods deliberately fail so the test
// cannot accidentally copy Explorer's focused/selected item for background.
class FolderView final : public IFolderView {
public:
    explicit FolderView(IShellFolder* folder) : folder_(folder) {}
    IFACEMETHODIMP QueryInterface(REFIID iid, void** output) override {
        if (!output) return E_POINTER;
        *output = nullptr;
        if (iid != IID_IUnknown && iid != IID_IFolderView) return E_NOINTERFACE;
        *output = static_cast<IFolderView*>(this);
        AddRef();
        return S_OK;
    }
    IFACEMETHODIMP_(ULONG) AddRef() override { return ++references_; }
    IFACEMETHODIMP_(ULONG) Release() override {
        const ULONG remaining = --references_;
        if (!remaining) delete this;
        return remaining;
    }
    IFACEMETHODIMP GetFolder(REFIID iid, void** output) override { return folder_->QueryInterface(iid, output); }
    IFACEMETHODIMP GetCurrentViewMode(UINT*) override { return E_NOTIMPL; }
    IFACEMETHODIMP SetCurrentViewMode(UINT) override { return E_NOTIMPL; }
    IFACEMETHODIMP Item(int, PITEMID_CHILD*) override { return E_NOTIMPL; }
    IFACEMETHODIMP ItemCount(UINT, int*) override { return E_NOTIMPL; }
    IFACEMETHODIMP Items(UINT, REFIID, void**) override { return E_NOTIMPL; }
    IFACEMETHODIMP GetSelectionMarkedItem(int*) override { return E_NOTIMPL; }
    IFACEMETHODIMP GetFocusedItem(int*) override { return E_NOTIMPL; }
    IFACEMETHODIMP GetItemPosition(PCUITEMID_CHILD, POINT*) override { return E_NOTIMPL; }
    IFACEMETHODIMP GetSpacing(POINT*) override { return E_NOTIMPL; }
    IFACEMETHODIMP GetDefaultSpacing(POINT*) override { return E_NOTIMPL; }
    IFACEMETHODIMP GetAutoArrange() override { return E_NOTIMPL; }
    IFACEMETHODIMP SelectItem(int, DWORD) override { return E_NOTIMPL; }
    IFACEMETHODIMP SelectAndPositionItems(UINT, PCUITEMID_CHILD_ARRAY, POINT*, DWORD) override { return E_NOTIMPL; }
private:
    std::atomic<ULONG> references_{1};
    ComPtr<IShellFolder> folder_;
};

class FolderSite final : public IServiceProvider {
public:
    explicit FolderSite(IFolderView* view) : view_(view) {}
    IFACEMETHODIMP QueryInterface(REFIID iid, void** output) override {
        if (!output) return E_POINTER;
        *output = nullptr;
        if (iid != IID_IUnknown && iid != IID_IServiceProvider) return E_NOINTERFACE;
        *output = static_cast<IServiceProvider*>(this);
        AddRef();
        return S_OK;
    }
    IFACEMETHODIMP_(ULONG) AddRef() override { return ++references_; }
    IFACEMETHODIMP_(ULONG) Release() override {
        const ULONG remaining = --references_;
        if (!remaining) delete this;
        return remaining;
    }
    IFACEMETHODIMP QueryService(REFGUID service, REFIID iid, void** output) override {
        if (!output) return E_POINTER;
        *output = nullptr;
        return service == SID_SFolderView ? view_->QueryInterface(iid, output) : E_NOINTERFACE;
    }
private:
    std::atomic<ULONG> references_{1};
    ComPtr<IFolderView> view_;
};

void ExpectArguments(IExplorerCommand* command, IShellItemArray* selection,
                     const std::wstring& record, const std::vector<std::wstring>& expected) {
    DeleteFileW(record.c_str());
    EXPCMDSTATE state = ECS_HIDDEN;
    success(command->GetState(selection, FALSE, &state), "GetState failed");
    require(state == ECS_ENABLED, "Filesystem menu must be enabled");
    success(command->Invoke(selection, nullptr), "Invoke failed");
    const auto actual = ReadArguments(record, expected.size() + 2);
    require(actual[0] == L"--copy-path" && actual[1] == L"--", "Child launch prefix differs");
    for (size_t index = 0; index < expected.size(); ++index) {
        if (actual[index + 2] != expected[index]) {
            throw std::runtime_error("Child path argv differs at index " + std::to_string(index) +
                "\nExpected: " + Utf8(expected[index]) + "\nActual: " + Utf8(actual[index + 2]));
        }
    }
}

template<typename Function> Function Export(HMODULE module, const char* name) {
    const auto address = GetProcAddress(module, name);
    static_assert(sizeof(Function) == sizeof(address), "Windows export pointer size differs");
    Function result = nullptr;
    memcpy(&result, &address, sizeof(result));
    return result;
}
} // namespace

int wmain(int count, wchar_t** arguments) {
    try {
        const std::wstring record = Environment(L"BRCLIO_SHELL_TEST_OUTPUT");
        require(!record.empty(), "Child record environment is missing");
        if (count >= 2 && std::wstring(arguments[1]) == L"--copy-path") {
            WriteArguments(record, count, arguments);
            return 0;
        }
        require(count == 3, "Usage: ComTests.exe INSTALL_ROOT PACKAGE_VERSION");
        // Node's TEMP can contain an 8.3 username; Shell filesystem names use
        // the existing directory's long form. Compare against that same path.
        const std::wstring install = LongPath(arguments[1]);
        const std::wstring packageVersion = arguments[2];
        std::vector<wchar_t> ownPath(32768);
        const DWORD length = GetModuleFileNameW(nullptr, ownPath.data(), static_cast<DWORD>(ownPath.size()));
        require(length && length < ownPath.size(), "Cannot locate test executable");
        require(CopyFileW(ownPath.data(), (install + L"\\Brclio.exe").c_str(), FALSE), "Cannot create fake Brclio executable");
        success(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED), "COM initialization failed");
        const HMODULE module = LoadLibraryW((install + L"\\resources\\windows-shell\\" + packageVersion + L"\\BrclioExplorerCommand.dll").c_str());
        require(module != nullptr, "Cannot load COM DLL");
        const auto getClassObject = Export<HRESULT (STDAPICALLTYPE*)(REFCLSID, REFIID, void**)>(module, "DllGetClassObject");
        const auto canUnload = Export<HRESULT (STDAPICALLTYPE*)()>(module, "DllCanUnloadNow");
        require(getClassObject && canUnload, "COM exports missing");
        require(canUnload() == S_OK, "Unused COM DLL must be unloadable");
        {
            ComPtr<IClassFactory> factory;
            success(getClassObject(CommandClass, IID_PPV_ARGS(&factory)), "Cannot get class factory");
            require(canUnload() == S_FALSE, "Live class factory must keep DLL loaded");
            ComPtr<IExplorerCommand> command;
            success(factory->CreateInstance(nullptr, IID_PPV_ARGS(&command)), "Cannot create IExplorerCommand");
            GUID canonical{};
            success(command->GetCanonicalName(&canonical), "Cannot get canonical command ID");
            require(canonical == CommandClass, "Canonical command ID differs");
            PWSTR title = nullptr;
            success(command->GetTitle(nullptr, &title), "Cannot get title");
            require(title && std::wstring(title) == L"复制路径 · Brclio", "Menu title differs");
            CoTaskMemFree(title);
            PWSTR icon = nullptr;
            success(command->GetIcon(nullptr, &icon), "Cannot get icon");
            require(icon && std::wstring(icon) == install + L"\\Brclio.exe,0", "Relative installed executable differs");
            CoTaskMemFree(icon);
            require(command->GetFlags(nullptr) == E_POINTER, "Null COM output must be rejected");
            std::vector<std::wstring> paths{install + L"\\中文🙂 & [%].txt", install + L"\\second file.txt"};
            for (const auto& path : paths) {
                const HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
                require(file != INVALID_HANDLE_VALUE, "Cannot create selection fixture");
                CloseHandle(file);
            }
            auto selection = Selection(paths);
            ExpectArguments(command.Get(), selection.Get(), record, paths);
            auto rootSelection = Selection({install.substr(0, 3)});
            ExpectArguments(command.Get(), rootSelection.Get(), record, {install.substr(0, 3)});
            ComPtr<IShellItem> folderItem;
            success(SHCreateItemFromParsingName(install.c_str(), nullptr, IID_PPV_ARGS(&folderItem)), "Cannot parse background folder");
            ComPtr<IShellFolder> folder;
            success(folderItem->BindToHandler(nullptr, BHID_SFObject, IID_PPV_ARGS(&folder)), "Cannot bind background folder");
            ComPtr<IFolderView> view;
            view.Attach(new FolderView(folder.Get()));
            ComPtr<IServiceProvider> site;
            site.Attach(new FolderSite(view.Get()));
            ComPtr<IObjectWithSite> withSite;
            success(command.As(&withSite), "IObjectWithSite is missing");
            success(withSite->SetSite(site.Get()), "SetSite failed");
            ExpectArguments(command.Get(), nullptr, record, {install});
            success(withSite->SetSite(nullptr), "Cannot clear site");
            EXPCMDSTATE state = ECS_ENABLED;
            success(command->GetState(nullptr, FALSE, &state), "Empty selection state failed");
            require(state == ECS_HIDDEN, "Context without selection or folder must be hidden");
            require(FAILED(command->Invoke(nullptr, nullptr)), "Missing folder must never launch Brclio");
        }
        require(canUnload() == S_OK, "Released COM instances must be unloadable");
        FreeLibrary(module);
        CoUninitialize();
        std::cout << "Windows COM selection, drive root, background, and child argv tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
