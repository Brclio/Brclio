#pragma once

#include <stdexcept>
#include <string>
#include <vector>

namespace brclio {
inline constexpr size_t MaxSelection = 1000;
// CreateProcessW includes the terminating NUL in its 32,767-character limit.
inline constexpr size_t MaxCommandLine = 32766;

// Quote for the Windows argv parser, never for cmd.exe or PowerShell. In
// particular, double a trailing backslash so a drive root retains its slash.
inline std::wstring QuoteArgument(const std::wstring& argument) {
    std::wstring result(1, L'"');
    size_t slashes = 0;
    for (const wchar_t character : argument) {
        if (character == L'\\') {
            ++slashes;
            continue;
        }
        result.append(slashes * (character == L'"' ? 2 : 1), L'\\');
        slashes = 0;
        if (character == L'"') result.push_back(L'\\');
        result.push_back(character);
    }
    result.append(slashes * 2, L'\\');
    result.push_back(L'"');
    return result;
}

inline std::wstring BuildCommandLine(const std::wstring& executable,
                                     const std::vector<std::wstring>& paths) {
    if (executable.empty() || executable.find(L'\0') != std::wstring::npos ||
        paths.empty() || paths.size() > MaxSelection) {
        throw std::invalid_argument("Invalid Brclio selection");
    }
    std::wstring result = QuoteArgument(executable) + L" --copy-path --";
    for (const auto& path : paths) {
        if (path.empty() || path.find(L'\0') != std::wstring::npos) {
            throw std::invalid_argument("Invalid Brclio path");
        }
        result += L" " + QuoteArgument(path);
        if (result.size() > MaxCommandLine) {
            throw std::length_error("Selection exceeds the Windows command-line limit");
        }
    }
    return result;
}
} // namespace brclio
