"""
Splits js/translation-offline.js into 5 FULLY SEPARATE, per-service copies,
per explicit user direction: every service gets its own independent engine
file, even if that means duplicating the ~5300-line rendering engine 5
times. Done mechanically (not by hand) to avoid transcription errors across
that much code.

WHY NAMESPACED EXPORTS (not just 5 copies of the same window.X = Y lines):
if all 5 files were loaded on the same page with identical flat
window.buildOfflineDocxBlob = ... assignments, whichever script loads LAST
would silently overwrite the others - defeating the entire point of
separation. Each copy's exports are wrapped in ITS OWN namespaced object
(window.__ocrEngine, window.__translationEngine, etc.) so they can never
collide, and each consuming file is updated to call its own namespace.

The two OCR-specific diagnostic markers (__ocrEngineBuildTag,
__ocrTextBoxXmlSource) are kept ONLY in the OCR copy - they were built
specifically to investigate an OCR bug and would be redundant/misleading
duplicated elsewhere.
"""
import re

SRC_PATH = "js/translation-offline.js"

SERVICES = [
    {"key": "ocr", "namespace": "__ocrEngine", "out": "js/engine-ocr.js", "keep_ocr_diagnostics": True},
    {"key": "translation", "namespace": "__translationEngine", "out": "js/engine-translation.js", "keep_ocr_diagnostics": False},
    {"key": "dataextraction", "namespace": "__dataExtractionEngine", "out": "js/engine-dataextraction.js", "keep_ocr_diagnostics": False},
    {"key": "bai2", "namespace": "__bai2Engine", "out": "js/engine-bai2.js", "keep_ocr_diagnostics": False},
    {"key": "calculators", "namespace": "__calculatorsEngine", "out": "js/engine-calculators.js", "keep_ocr_diagnostics": False},
]

EXPORT_BLOCK_OLD = """  window.buildHybridDocxBlob = buildHybridDocxBlob;
  window.setVisionAuthToken = setVisionAuthToken;
  window.setVisionStopCheck = setStopCheck;
  window.setPipelineEventHandler = setPipelineEventHandler;
  // Shared LLM access for other service modules (e.g. Data Extraction).
  // Everything still goes through the server proxy, so the API key never
  // reaches the browser, and calls are counted/abortable like the rest.
  window.lexoraProxyJson = v14ProxyJson;
  window.lexoraPdfToImages = v14PdfToImages;
  window.resetPipelineApiCounters = resetApiCalls;
  window.abortVision = abortVision;

    window.buildOfflineDocxBlob = buildOfflineDocxBlob;
})();
"""

OCR_DIAGNOSTIC_LINE_1 = "  window.__ocrEngineBuildTag = 'ocr-singleword-leftalign-fix-2026-08-20';\n"
OCR_DIAGNOSTIC_LINE_2 = "  window.__ocrTextBoxXmlSource = textBoxXml.toString();\n"


def build_export_block(namespace):
    return (
        "  // NAMESPACED exports - this file is one of 5 fully-separate,\n"
        "  // per-service copies of the same engine (split per explicit user\n"
        "  // direction: each service must have its own independent file).\n"
        "  // Kept as a namespaced OBJECT (not flat window.X = Y) so that\n"
        "  // loading all 5 copies on the same page can never let one\n"
        "  // service's copy silently overwrite another's.\n"
        f"  window.{namespace} = {{\n"
        "    buildHybridDocxBlob: buildHybridDocxBlob,\n"
        "    buildOfflineDocxBlob: buildOfflineDocxBlob,\n"
        "    setVisionAuthToken: setVisionAuthToken,\n"
        "    setVisionStopCheck: setStopCheck,\n"
        "    setPipelineEventHandler: setPipelineEventHandler,\n"
        "    lexoraProxyJson: v14ProxyJson,\n"
        "    lexoraPdfToImages: v14PdfToImages,\n"
        "    resetPipelineApiCounters: resetApiCalls,\n"
        "    abortVision: abortVision\n"
        "  };\n"
        "})();\n"
    )


def main():
    with open(SRC_PATH, "r", encoding="utf-8") as f:
        src = f.read()

    assert EXPORT_BLOCK_OLD in src, "Export block not found verbatim - source may have changed, re-check before editing the script"
    assert OCR_DIAGNOSTIC_LINE_1 in src, "OCR diagnostic marker 1 not found verbatim"
    assert OCR_DIAGNOSTIC_LINE_2 in src, "OCR diagnostic marker 2 not found verbatim"

    for svc in SERVICES:
        content = src
        # Swap the shared export block for this service's namespaced one.
        content = content.replace(EXPORT_BLOCK_OLD, build_export_block(svc["namespace"]))
        # Remove the OCR-specific diagnostic markers from every copy except OCR's own.
        if not svc["keep_ocr_diagnostics"]:
            content = content.replace(OCR_DIAGNOSTIC_LINE_1, "")
            content = content.replace(OCR_DIAGNOSTIC_LINE_2, "")

        header = (
            f"/* {svc['out']} - FULLY SEPARATE per-service copy of the shared\n"
            f" * rendering engine (originally translation-offline.js), split per\n"
            f" * explicit user direction so every service has its own independent\n"
            f" * file - deliberate duplication, not a shared import, so a fix or a\n"
            f" * cache/deploy issue in one service's copy can never be confused\n"
            f" * with another's. Exports live under window.{svc['namespace']} only\n"
            f" * (not flat window.* names) to avoid collisions with the other 4\n"
            f" * copies loaded on the same page. */\n"
        )
        # Replace the original file's own header comment with this service-specific one.
        content = re.sub(r"^/\* translation-offline\.js.*?\*/\n", header, content, count=1, flags=re.DOTALL)

        with open(svc["out"], "w", encoding="utf-8") as out:
            out.write(content)
        print(f"wrote {svc['out']} ({len(content)} bytes)")


if __name__ == "__main__":
    main()
