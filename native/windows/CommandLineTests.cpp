#include "CommandLine.h"
#include <iostream>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#endif

void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

int main() {
    using brclio::QuoteArgument;
    require(QuoteArgument(L"C:\\") == L"\"C:\\\\\"", "Drive root must keep its trailing slash");
    require(QuoteArgument(L"\\\\server\\share\\") == L"\"\\\\server\\share\\\\\"", "UNC root must keep its trailing slash");
    require(QuoteArgument(L"C:\\a & b\\中文🙂.txt") == L"\"C:\\a & b\\中文🙂.txt\"", "Unicode and shell characters must be literal");
    require(QuoteArgument(L"a\\\"b") == L"\"a\\\\\\\"b\"", "Backslash before quote must be escaped");
    const std::wstring executable = L"C:\\Program Files\\Brclio\\Brclio.exe";
    const std::vector<std::wstring> paths = {L"C:\\", L"C:\\a & b\\中文🙂.txt", L"\\\\server\\share\\", L"--literal.txt"};
    const auto command = brclio::BuildCommandLine(executable, paths);
#ifdef _WIN32
    // Verify the Windows parser itself, independently of the quoting helper.
    int count = 0;
    auto arguments = CommandLineToArgvW(command.c_str(), &count);
    require(arguments != nullptr && count == static_cast<int>(paths.size()) + 3, "Windows argv count differs");
    require(arguments[0] == executable && std::wstring(arguments[1]) == L"--copy-path" &&
            std::wstring(arguments[2]) == L"--", "Windows launch prefix differs");
    for (size_t index = 0; index < paths.size(); ++index) {
        require(arguments[index + 3] == paths[index], "Windows argv path roundtrip failed");
    }
    LocalFree(arguments);
#else
    require(command.find(L" --copy-path -- ") != std::wstring::npos, "Selection needs an option separator");
#endif
    require(brclio::BuildCommandLine(executable, std::vector<std::wstring>(1000, L"C:\\a")).size() > 0,
            "1000 short paths must be accepted");
    for (const auto& invalid : std::vector<std::vector<std::wstring>>{{}, {L""}, {std::wstring(L"a\0b", 3)}, std::vector<std::wstring>(1001, L"C:\\a")}) {
        bool rejected = false;
        try { brclio::BuildCommandLine(executable, invalid); }
        catch (const std::invalid_argument&) { rejected = true; }
        require(rejected, "Invalid selection must be rejected as a whole");
    }
    bool tooLong = false;
    try { brclio::BuildCommandLine(executable, {std::wstring(32767, L'a')}); }
    catch (const std::length_error&) { tooLong = true; }
    require(tooLong, "Overlong Windows command line must be rejected");
    std::cout << "Windows command-line selection tests passed\n";
}
