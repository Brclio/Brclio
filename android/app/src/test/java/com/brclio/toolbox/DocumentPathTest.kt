package com.brclio.toolbox

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DocumentPathTest {
    private val provider = DocumentPath.PRIMARY_AUTHORITY
    private val root = "/storage/emulated/0"

    @Test fun resolvesOnlyKnownPrimaryStorageDocuments() {
        assertEquals("$root/Documents/产品计划.pdf", DocumentPath.primaryPath(provider, "primary:Documents/产品计划.pdf", root))
        assertEquals(root, DocumentPath.primaryPath(provider, "primary:", "$root/"))
        assertNull(DocumentPath.primaryPath(provider, "2A37-XXXX:photo.jpg", root))
        assertNull(DocumentPath.primaryPath("com.google.android.apps.docs.storage", "primary:photo.jpg", root))
        assertNull(DocumentPath.primaryPath("com.android.providers.downloads.documents", "1234", root))
    }

    @Test fun rejectsTraversalAndMalformedDocumentIds() {
        for (id in listOf("primary:../secret", "primary:Documents/../../secret", "primary:/etc/passwd", "primary:a\\b", "primary:a\u0000b", "primary:./a")) {
            assertNull("Must keep URI instead of inventing an absolute path for $id", DocumentPath.primaryPath(provider, id, root))
        }
    }
}
