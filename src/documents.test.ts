import { test, expect } from "bun:test";
import { sanitizeFilename, isAllowedDoc, inboxPathFor, MAX_DOC_BYTES } from "./documents";

test("sanitizeFilename strips paths and unsafe chars", () => {
  expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
  expect(sanitizeFilename("My CV (final).pdf")).toBe("My_CV_final_.pdf");
  expect(sanitizeFilename("/a/b/résumé.pdf")).toBe("r_sum_.pdf");
  expect(sanitizeFilename("")).toBe("file");
  expect(sanitizeFilename("...")).toBe("file");
});

test("isAllowedDoc gates by extension and size", () => {
  expect(isAllowedDoc("resume.pdf", 1000).ok).toBe(true);
  expect(isAllowedDoc("resume.docx", 1000).ok).toBe(true);
  expect(isAllowedDoc("malware.exe", 1000).ok).toBe(false);
  expect(isAllowedDoc("resume.pdf", MAX_DOC_BYTES + 1).ok).toBe(false);
});

test("inboxPathFor lands under the agent workspace inbox with a safe name", () => {
  expect(inboxPathFor("/state", "athena", "../CV.pdf")).toBe("/state/workspace-athena/inbox/CV.pdf");
  expect(inboxPathFor("/state", "main", "notes.md")).toBe("/state/workspace/inbox/notes.md");
});
