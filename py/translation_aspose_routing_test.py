"""
Standalone regression test for the NEW Translation-service Aspose
routing wired into py/server.py:
  /api/translation/analyze-strategy -> _handle_translation_analyze_strategy
  /api/translation/process-aspose   -> _handle_translation_process_aspose

Per explicit direction: table/background documents route to Aspose
(structure-aware conversion + real in-place LLM translation, via
aspose_test_pipeline.run_full_test - already tested through the admin
Aspose test route); everything else uses the existing client-side
pdf.js text-layer pipeline (js/engine-translation.js), unchanged.

This deliberately reuses ocr_router.analyze_pdf_for_ocr_strategy
directly (not a second copy of the same table/background-detection
logic) and aspose_test_pipeline.run_full_test directly (not a second
Aspose+translate pipeline) - this test confirms BOTH the reuse is wired
correctly AND the underlying decision is still correct for Translation's
own real documents.

Run: python3 translation_aspose_routing_test.py [path/to/table_pdf.pdf]
The second PDF (with real tables/background) is optional - if not
given, only the plain-text routing check runs (still meaningful: it's
exactly the shape of document Translation processes every day).
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
import ocr_router  # noqa: E402


def assert_(cond, label):
    if not cond:
        print("FAIL:", label)
        sys.exit(1)
    print("PASS:", label)


def run(plain_pdf, table_pdf=None):
    print("=== Test 1: plain-text PDF (Translation's everyday case) -> lightweight (pdf.js) ===")
    analysis = ocr_router.analyze_pdf_for_ocr_strategy(plain_pdf)
    assert_(analysis["strategy"] == "lightweight", "Plain document routes to lightweight, not Aspose - " + analysis["reason"][:80])

    print("\n=== Test 2: server.py wiring - both new routes registered ===")
    server_src = open(os.path.join(os.path.dirname(__file__), "server.py")).read()
    assert_('"/api/translation/analyze-strategy": self._handle_translation_analyze_strategy' in server_src,
            "/api/translation/analyze-strategy is registered in the URL routing table")
    assert_('"/api/translation/process-aspose": self._handle_translation_process_aspose' in server_src,
            "/api/translation/process-aspose is registered in the URL routing table")

    print("\n=== Test 3: handler bodies reuse the EXISTING, already-tested functions (not reimplementations) ===")
    def extract_method(name):
        start = server_src.find("def " + name + "(")
        assert start != -1, name + " not found"
        # crude but sufficient: grab up to the next top-level "    def "
        next_def = server_src.find("\n    def ", start + 1)
        return server_src[start:next_def if next_def != -1 else start + 4000]

    analyze_src = extract_method("_handle_translation_analyze_strategy")
    assert_("ocr_router.analyze_pdf_for_ocr_strategy(" in analyze_src,
            "_handle_translation_analyze_strategy reuses ocr_router.analyze_pdf_for_ocr_strategy directly (no duplicate table/background detection logic)")

    aspose_src = extract_method("_handle_translation_process_aspose")
    assert_("asp_test.run_full_test(" in aspose_src,
            "_handle_translation_process_aspose reuses aspose_test_pipeline.run_full_test directly (the same, already-tested Aspose+translate pipeline the admin test route uses)")
    assert_("AsposeNotConfiguredError" in aspose_src,
            "_handle_translation_process_aspose handles the not-configured case explicitly rather than letting it surface as a raw crash")

    print("\n=== Test 4: neither new route requires Admin/Developer role (real users must be able to call these) ===")
    assert_("_require_role" not in analyze_src, "_handle_translation_analyze_strategy has no role restriction")
    assert_("_require_role" not in aspose_src, "_handle_translation_process_aspose has no role restriction")

    if table_pdf:
        print("\n=== Test 5: real table/background PDF -> aspose ===")
        analysis2 = ocr_router.analyze_pdf_for_ocr_strategy(table_pdf)
        assert_(analysis2["strategy"] == "aspose", "Table/background document correctly routes to aspose - " + analysis2["reason"][:80])

    print("\nALL TESTS PASSED")


if __name__ == "__main__":
    default_plain = "/home/claude/work/ocr_debug/s36.pdf"
    plain = sys.argv[1] if len(sys.argv) > 1 else default_plain
    table = sys.argv[2] if len(sys.argv) > 2 else None
    if not os.path.exists(plain):
        print("Plain-text test PDF not found:", plain)
        sys.exit(1)
    run(plain, table)
