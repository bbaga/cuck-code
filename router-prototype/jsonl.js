"use strict";

class JsonlDecoder {
  constructor() {
    this.buffer = "";
  }

  push(chunk) {
    this.buffer += String(chunk);
    const records = [];
    let newline;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      let record = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (record.endsWith("\r")) record = record.slice(0, -1);
      records.push(record);
    }
    return records;
  }

  finish() {
    if (!this.buffer) return [];
    let record = this.buffer;
    this.buffer = "";
    if (record.endsWith("\r")) record = record.slice(0, -1);
    return [record];
  }
}

function parseJsonRecord(record) {
  try {
    return JSON.parse(record);
  } catch {
    return null;
  }
}

module.exports = { JsonlDecoder, parseJsonRecord };
