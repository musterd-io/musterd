/**
 * A small RFC 4180 reader for `musterd import` (spec 2026-10-10 "bring work in"). Hand-written rather
 * than a dependency (AGENTS.md hard rule 6): quoted fields, `""` escapes, commas and newlines inside
 * quotes, a header row, CRLF/LF/CR, and the UTF-8 BOM spreadsheet exports prepend.
 */
export class CsvError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`${message} (line ${String(line)})`);
  }
}

export function readCsv(text: string): string[][] {
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let line = 1;
  let quoted = false;
  let quoteLine = 0;
  let fieldStarted = false;
  let i = 0;

  const endField = () => {
    record.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };

  while (i < src.length) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      if (c === '\n') line += 1;
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      if (fieldStarted) throw new CsvError('a quote inside an unquoted field', line);
      quoted = true;
      quoteLine = line;
      fieldStarted = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      endField();
      i += 1;
      continue;
    }
    if (c === '\r' || c === '\n') {
      endRecord();
      i += c === '\r' && src[i + 1] === '\n' ? 2 : 1;
      line += 1;
      continue;
    }
    field += c;
    fieldStarted = true;
    i += 1;
  }
  if (quoted) throw new CsvError('an unterminated quote', quoteLine);
  if (fieldStarted || field !== '' || record.length > 0) endRecord();
  return records;
}
