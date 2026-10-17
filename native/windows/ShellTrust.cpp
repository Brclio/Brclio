// This small elevated helper can trust only the public leaf whose SHA-256 was
// compiled into this build. It never opens a Root store or executes commands.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <wincrypt.h>
#include <shellapi.h>
#include <shlwapi.h>
#include <winrt/base.h>
#include <winrt/Windows.ApplicationModel.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Management.Deployment.h>
#include <algorithm>
#include <cstring>
#include <iterator>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#ifndef EXPECTED_CERT_SHA256
#error The build must compile the exact public certificate SHA-256 pin.
#endif

namespace {
constexpr wchar_t Owner[] = L"com.brclio.toolbox";
constexpr wchar_t MarkerParent[] = L"Software\\Brclio\\ShellCertificates";
constexpr wchar_t PackageName[] = L"Brclio.Toolbox.Shell";

struct CertificateDeleter {
    void operator()(const CERT_CONTEXT* value) const noexcept { if (value) CertFreeCertificateContext(value); }
};
using Certificate = std::unique_ptr<const CERT_CONTEXT, CertificateDeleter>;
struct StoreDeleter {
    void operator()(void* value) const noexcept { if (value) CertCloseStore(value, 0); }
};
using Store = std::unique_ptr<void, StoreDeleter>;
class Key {
public:
    HKEY value = nullptr;
    ~Key() { if (value) RegCloseKey(value); }
    Key() = default;
    Key(const Key&) = delete;
    Key& operator=(const Key&) = delete;
};

void CheckRegistry(LSTATUS result) {
    if (result != ERROR_SUCCESS) winrt::throw_hresult(HRESULT_FROM_WIN32(result));
}
void Require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}
std::wstring Hex(const BYTE* bytes, size_t count) {
    constexpr wchar_t digits[] = L"0123456789abcdef";
    std::wstring result;
    result.reserve(count * 2);
    for (size_t index = 0; index < count; ++index) {
        result.push_back(digits[bytes[index] >> 4]);
        result.push_back(digits[bytes[index] & 15]);
    }
    return result;
}
std::wstring Hash(const BYTE* bytes, DWORD count) {
    BYTE hash[32]{};
    DWORD size = sizeof(hash);
    if (!CryptHashCertificate2(L"SHA256", 0, nullptr, bytes, count, hash, &size)) winrt::throw_last_error();
    Require(size == sizeof(hash), "Unexpected public certificate hash size");
    return Hex(hash, size);
}
std::wstring Hash(PCCERT_CONTEXT certificate) { return Hash(certificate->pbCertEncoded, certificate->cbCertEncoded); }
bool SameCertificate(PCCERT_CONTEXT left, PCCERT_CONTEXT right) noexcept {
    return left->cbCertEncoded == right->cbCertEncoded &&
        std::memcmp(left->pbCertEncoded, right->pbCertEncoded, left->cbCertEncoded) == 0;
}
std::wstring Thumbprint(PCCERT_CONTEXT certificate) {
    BYTE hash[20]{};
    DWORD size = sizeof(hash);
    if (!CertGetCertificateContextProperty(certificate, CERT_SHA1_HASH_PROP_ID, hash, &size)) winrt::throw_last_error();
    Require(size == sizeof(hash), "Unexpected certificate thumbprint size");
    return Hex(hash, size);
}
std::wstring Subject(PCCERT_CONTEXT certificate) {
    const DWORD flags = CERT_X500_NAME_STR | CERT_NAME_STR_REVERSE_FLAG;
    const DWORD size = CertNameToStrW(X509_ASN_ENCODING, &certificate->pCertInfo->Subject, flags, nullptr, 0);
    Require(size > 1, "Certificate publisher is missing");
    std::wstring result(size, L'\0');
    if (CertNameToStrW(X509_ASN_ENCODING, &certificate->pCertInfo->Subject, flags, result.data(), size) != size) winrt::throw_last_error();
    result.resize(size - 1);
    return result;
}
bool LeafCodeSigning(PCCERT_CONTEXT certificate, bool checkTime = true) {
    if ((checkTime && CertVerifyTimeValidity(nullptr, certificate->pCertInfo) != 0) ||
        !CertCompareCertificateName(X509_ASN_ENCODING, &certificate->pCertInfo->Subject, &certificate->pCertInfo->Issuer)) return false;
    const auto extension = CertFindExtension(szOID_BASIC_CONSTRAINTS2,
        certificate->pCertInfo->cExtension, certificate->pCertInfo->rgExtension);
    if (!extension) return false;
    CERT_BASIC_CONSTRAINTS2_INFO* constraints = nullptr;
    DWORD decoded = 0;
    if (!CryptDecodeObjectEx(X509_ASN_ENCODING, X509_BASIC_CONSTRAINTS2, extension->Value.pbData,
                            extension->Value.cbData, CRYPT_DECODE_ALLOC_FLAG, nullptr, &constraints, &decoded)) return false;
    const bool isCA = constraints->fCA != FALSE;
    LocalFree(constraints);
    if (isCA) return false;
    BYTE usage = 0;
    if (!CertGetIntendedKeyUsage(X509_ASN_ENCODING, certificate->pCertInfo, &usage, sizeof(usage)) ||
        !(usage & CERT_DIGITAL_SIGNATURE_KEY_USAGE) || (usage & CERT_KEY_CERT_SIGN_KEY_USAGE)) return false;
    DWORD size = 0;
    if (!CertGetEnhancedKeyUsage(certificate, 0, nullptr, &size) || !size) return false;
    std::vector<BYTE> buffer(size);
    const auto usages = reinterpret_cast<PCERT_ENHKEY_USAGE>(buffer.data());
    if (!CertGetEnhancedKeyUsage(certificate, 0, usages, &size)) return false;
    for (DWORD index = 0; index < usages->cUsageIdentifier; ++index) {
        if (std::strcmp(usages->rgpszUsageIdentifier[index], szOID_KP_CODE_SIGNING) == 0) return true;
    }
    return false;
}
Certificate ReadCertificate(const wchar_t* filename) {
    Require(!PathIsRelativeW(filename), "The public certificate path must be absolute");
    const HANDLE file = CreateFileW(filename, GENERIC_READ, FILE_SHARE_READ, nullptr,
                                    OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
    if (file == INVALID_HANDLE_VALUE) winrt::throw_last_error();
    struct CloseFile { HANDLE value; ~CloseFile() { CloseHandle(value); } } close{file};
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(file, &size)) winrt::throw_last_error();
    Require(size.QuadPart > 0 && size.QuadPart <= 65536, "Invalid public certificate size");
    std::vector<BYTE> bytes(static_cast<size_t>(size.QuadPart));
    DWORD read = 0;
    if (!ReadFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr)) winrt::throw_last_error();
    Require(read == bytes.size(), "Cannot read the complete public certificate");
    const std::string pin = EXPECTED_CERT_SHA256;
    Require(pin.size() == 64 && Hash(bytes.data(), read) == std::wstring(pin.begin(), pin.end()),
            "The public certificate does not match this Brclio build");
    Certificate certificate(CertCreateCertificateContext(X509_ASN_ENCODING, bytes.data(), read));
    if (!certificate) winrt::throw_last_error();
    Require(LeafCodeSigning(certificate.get()), "Expected a valid, self-signed, non-CA code-signing leaf");
    return certificate;
}
Store MachineStore(bool create = true) {
    Store store(CertOpenStore(CERT_STORE_PROV_SYSTEM_W, 0, 0,
        CERT_SYSTEM_STORE_LOCAL_MACHINE | (create ? 0 : CERT_STORE_OPEN_EXISTING_FLAG), L"TrustedPeople"));
    if (!store) {
        const DWORD error = GetLastError();
        if (!create && (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND ||
                        error == static_cast<DWORD>(CRYPT_E_NOT_FOUND))) return {};
        winrt::throw_hresult(HRESULT_FROM_WIN32(error));
    }
    return store;
}
Certificate FindCertificate(HCERTSTORE store, PCCERT_CONTEXT certificate) {
    BYTE hash[20]{};
    DWORD size = sizeof(hash);
    if (!CertGetCertificateContextProperty(certificate, CERT_SHA1_HASH_PROP_ID, hash, &size)) winrt::throw_last_error();
    CRYPT_HASH_BLOB blob{size, hash};
    Certificate found(CertFindCertificateInStore(store, X509_ASN_ENCODING, 0, CERT_FIND_SHA1_HASH, &blob, nullptr));
    if (!found && GetLastError() != static_cast<DWORD>(CRYPT_E_NOT_FOUND)) winrt::throw_last_error();
    return found;
}
std::wstring ReadString(HKEY key, const wchar_t* name) {
    DWORD type = 0;
    DWORD size = 0;
    const LSTATUS query = RegQueryValueExW(key, name, nullptr, &type, nullptr, &size);
    if (query != ERROR_SUCCESS || type != REG_SZ || size < sizeof(wchar_t) || size > 32768 || size % sizeof(wchar_t)) return {};
    std::wstring result(size / sizeof(wchar_t), L'\0');
    if (RegQueryValueExW(key, name, nullptr, &type, reinterpret_cast<BYTE*>(result.data()), &size) != ERROR_SUCCESS || type != REG_SZ) return {};
    while (!result.empty() && result.back() == L'\0') result.pop_back();
    if (result.find(L'\0') != std::wstring::npos) return {};
    return result;
}
void WriteString(HKEY key, const wchar_t* name, const std::wstring& value) {
    CheckRegistry(RegSetValueExW(key, name, 0, REG_SZ, reinterpret_cast<const BYTE*>(value.c_str()),
                               static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t))));
}
bool OwnedMarker(HKEY key, const std::wstring& hash, const std::wstring& publisher) {
    return ReadString(key, L"BrclioOwner") == Owner && ReadString(key, L"CertificateSha256") == hash &&
           ReadString(key, L"Publisher") == publisher;
}
int Add(const wchar_t* filename) {
    const auto certificate = ReadCertificate(filename);
    const auto publisher = Subject(certificate.get());
    const auto hash = Hash(certificate.get());
    const auto marker = std::wstring(MarkerParent) + L"\\" + Thumbprint(certificate.get());
    const auto store = MachineStore();
    auto existing = FindCertificate(store.get(), certificate.get());
    if (existing) {
        Require(SameCertificate(existing.get(), certificate.get()), "An existing certificate thumbprint does not match");
        return 0; // Preserve manually established trust and its ownership.
    }
    {
        Key previous;
        const LSTATUS opened = RegOpenKeyExW(HKEY_LOCAL_MACHINE, marker.c_str(), 0,
            KEY_QUERY_VALUE | KEY_WOW64_64KEY, &previous.value);
        if (opened == ERROR_SUCCESS) Require(OwnedMarker(previous.value, hash, publisher), "A foreign certificate ownership marker exists");
        else if (opened != ERROR_FILE_NOT_FOUND) CheckRegistry(opened);
    }
    PCCERT_CONTEXT addedRaw = nullptr;
    if (!CertAddCertificateContextToStore(store.get(), certificate.get(), CERT_STORE_ADD_NEW, &addedRaw)) {
        if (GetLastError() == static_cast<DWORD>(CRYPT_E_EXISTS)) {
            auto raced = FindCertificate(store.get(), certificate.get());
            if (raced && SameCertificate(raced.get(), certificate.get())) return 0;
        }
        winrt::throw_last_error();
    }
    Certificate added(addedRaw);
    DWORD disposition = 0;
    try {
        Key key;
        CheckRegistry(RegCreateKeyExW(HKEY_LOCAL_MACHINE, marker.c_str(), 0, nullptr, 0,
            KEY_SET_VALUE | KEY_QUERY_VALUE | KEY_WOW64_64KEY, nullptr, &key.value, &disposition));
        if (disposition == REG_OPENED_EXISTING_KEY) Require(OwnedMarker(key.value, hash, publisher), "A foreign certificate ownership marker appeared");
        WriteString(key.value, L"BrclioOwner", Owner);
        WriteString(key.value, L"CertificateSha256", hash);
        WriteString(key.value, L"Publisher", publisher);
        return 10;
    } catch (...) {
        CertDeleteCertificateFromStore(added.release());
        if (disposition == REG_CREATED_NEW_KEY) RegDeleteKeyExW(HKEY_LOCAL_MACHINE, marker.c_str(), KEY_WOW64_64KEY, 0);
        throw;
    }
}
bool HexString(const std::wstring& value, size_t length) {
    return value.size() == length && std::all_of(value.begin(), value.end(), [](wchar_t character) {
        return (character >= L'0' && character <= L'9') || (character >= L'a' && character <= L'f') ||
               (character >= L'A' && character <= L'F');
    });
}
int Cleanup(const std::wstring& onlyThumbprint = {}) {
    Key parent;
    const LSTATUS opened = RegOpenKeyExW(HKEY_LOCAL_MACHINE, MarkerParent, 0,
        KEY_ENUMERATE_SUB_KEYS | KEY_QUERY_VALUE | KEY_WOW64_64KEY, &parent.value);
    if (opened == ERROR_FILE_NOT_FOUND) return 0;
    CheckRegistry(opened);
    std::vector<std::wstring> names;
    for (DWORD index = 0;; ++index) {
        wchar_t name[256]{};
        DWORD size = static_cast<DWORD>(std::size(name));
        const LSTATUS result = RegEnumKeyExW(parent.value, index, name, &size, nullptr, nullptr, nullptr, nullptr);
        if (result == ERROR_NO_MORE_ITEMS) break;
        CheckRegistry(result);
        if (HexString(std::wstring(name, size), 40) &&
            (onlyThumbprint.empty() || _wcsicmp(onlyThumbprint.c_str(), name) == 0)) names.emplace_back(name, size);
    }
    const auto store = MachineStore(false);
    if (!store) return 0;
    const winrt::Windows::Management::Deployment::PackageManager packages;
    for (const auto& name : names) {
        const auto marker = std::wstring(MarkerParent) + L"\\" + name;
        Key key;
        if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, marker.c_str(), 0, KEY_QUERY_VALUE | KEY_WOW64_64KEY, &key.value) != ERROR_SUCCESS) continue;
        const auto hash = ReadString(key.value, L"CertificateSha256");
        const auto publisher = ReadString(key.value, L"Publisher");
        if (!HexString(hash, 64) || publisher.empty() || !OwnedMarker(key.value, hash, publisher)) continue;
        try {
            if (packages.FindPackages(PackageName, publisher).First().HasCurrent()) continue;
        } catch (...) { continue; } // Unknown cross-user state preserves trust.
        // Find this marker's certificate, then independently check every byte
        // identity before changing either the certificate store or marker.
        Certificate current;
        PCCERT_CONTEXT enumerated = nullptr;
        while ((enumerated = CertEnumCertificatesInStore(store.get(), enumerated)) != nullptr) {
            if (_wcsicmp(Thumbprint(enumerated).c_str(), name.c_str()) == 0) {
                current.reset(CertDuplicateCertificateContext(enumerated));
                CertFreeCertificateContext(enumerated);
                break;
            }
        }
        if (current) {
            if (_wcsicmp(Hash(current.get()).c_str(), hash.c_str()) != 0 || Subject(current.get()) != publisher || !LeafCodeSigning(current.get(), false)) continue;
            if (!CertDeleteCertificateFromStore(current.release())) winrt::throw_last_error();
        }
        RegCloseKey(key.value);
        key.value = nullptr;
        CheckRegistry(RegDeleteKeyExW(HKEY_LOCAL_MACHINE, marker.c_str(), KEY_WOW64_64KEY, 0));
    }
    return 0;
}
void Diagnostic(const char* message) noexcept {
    const HANDLE output = GetStdHandle(STD_ERROR_HANDLE);
    if (output && output != INVALID_HANDLE_VALUE) {
        DWORD written = 0;
        WriteFile(output, message, static_cast<DWORD>(std::strlen(message)), &written, nullptr);
    }
}
} // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    int count = 0;
    wchar_t** arguments = CommandLineToArgvW(GetCommandLineW(), &count);
    if (!arguments) return 20;
    struct FreeArguments { wchar_t** value; ~FreeArguments() { LocalFree(value); } } free{arguments};
    try {
        winrt::init_apartment(winrt::apartment_type::multi_threaded);
        if (count == 3 && std::wstring(arguments[1]) == L"--add") return Add(arguments[2]);
        if (count == 3 && std::wstring(arguments[1]) == L"--remove") {
            const auto certificate = ReadCertificate(arguments[2]);
            return Cleanup(Thumbprint(certificate.get()));
        }
        if (count == 2 && std::wstring(arguments[1]) == L"--cleanup") return Cleanup();
        return 2;
    } catch (const winrt::hresult_error& error) {
        Diagnostic("Brclio machine certificate operation failed.\n");
        return static_cast<int>(error.code().value);
    }
    catch (const std::exception& error) { Diagnostic(error.what()); }
    catch (...) { Diagnostic("Brclio machine certificate operation failed.\n"); }
    return 20;
}
