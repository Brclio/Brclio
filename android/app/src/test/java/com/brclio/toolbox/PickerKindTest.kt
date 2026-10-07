package com.brclio.toolbox

import org.junit.Assert.assertEquals
import org.junit.Test

class PickerKindTest {
    @Test fun bothSharedUiFolderActionsRequestTreeSelection() {
        assertEquals(PickerKind.DIRECTORY, PickerKind.fromWebKind("directory"))
        assertEquals(PickerKind.DIRECTORY, PickerKind.fromWebKind("base"))
        assertEquals(PickerKind.FILE, PickerKind.fromWebKind("file"))
    }

    @Test(expected = IllegalArgumentException::class)
    fun unknownUiActionMustNotSilentlyPickFiles() {
        PickerKind.fromWebKind("unknown")
    }
}
