"""
Regression test for the NEW /api/translation/aspose-convert endpoint
and its client-side wiring in app.js, implementing ONLY step 1 of the
translation pipeline per explicit direction: on start, send the PDF to
Aspose and get back the converted Word document - nothing else yet
(no translation, no table/background routing, no pdf.js/vision-OCR
path). Further steps are deliberately not implemented here, to be
wired in only per further explicit instruction.

Run: python3 aspose_convert_step1_test.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))


def assert_(cond, label):
    if not cond:
        print("FAIL:", label)
        sys.exit(1)
    print("PASS:", label)


def run():
    print("=== Test 1: server.py wiring - new route registered ===")
    server_src = open(os.path.join(os.path.dirname(__file__), "server.py")).read()
    assert_('"/api/translation/aspose-convert": self._handle_translation_aspose_convert' in server_src,
            "/api/translation/aspose-convert is registered in the URL routing table")

    print("\n=== Test 2: handler reuses run_structure_only_test (no translation happening) ===")
    start = server_src.find("def _handle_translation_aspose_convert(")
    assert_(start != -1, "_handle_translation_aspose_convert is defined")
    next_def = server_src.find("\n    def ", start + 1)
    handler_src = server_src[start:next_def if next_def != -1 else start + 3000]
    assert_("run_structure_only_test(" in handler_src,
            "Reuses run_structure_only_test (pure conversion, zero LLM/translation calls) - not run_full_test")
    assert_("run_full_test(" not in handler_src, "Does NOT call run_full_test - no translation happens in this step")
    assert_("_require_role" not in handler_src, "No role restriction - real users can call this")
    assert_("AsposeNotConfiguredError" in handler_src, "Handles the not-configured case explicitly")

    print("\n=== Test 3: app.js wiring - calls the new endpoint, old routing removed ===")
    app_src = open(os.path.join(os.path.dirname(__file__), "..", "js", "app.js")).read()
    assert_("fetch('/api/translation/aspose-convert'" in app_src, "app.js calls the new /api/translation/aspose-convert endpoint")
    assert_("fetch('/api/translation/analyze-strategy'" not in app_src, "The old table/background analyze-strategy call is removed from the reachable flow")
    assert_("fetch('/api/translation/process-aspose'" not in app_src, "The old process-aspose (structure+translate) call is removed from the reachable flow")
    assert_("buildOfflineDocxBlob(blob" not in app_src.split("if (browserBuild) {")[1].split("} catch (offErr)")[0],
            "The pdf.js client-side path is not called in the reachable Translation flow right now")

    print("\nALL TESTS PASSED")


if __name__ == "__main__":
    run()
