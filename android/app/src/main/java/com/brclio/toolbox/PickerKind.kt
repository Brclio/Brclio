package com.brclio.toolbox

/** Public UI contract: both directory selection and relative-base selection open SAF trees. */
enum class PickerKind {
    FILE, DIRECTORY;

    companion object {
        fun fromWebKind(kind: String): PickerKind = when (kind) {
            "file", "files" -> FILE
            "directory", "folder", "base" -> DIRECTORY
            else -> throw IllegalArgumentException("无效的文件选择类型。")
        }
    }
}
