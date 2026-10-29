CREATE TABLE IF NOT EXISTS documents (
  build_id TEXT NOT NULL,
  id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  title TEXT NOT NULL,
  ext TEXT NOT NULL,
  year TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  pages INTEGER NOT NULL DEFAULT 0,
  extracted_chars INTEGER NOT NULL DEFAULT 0,
  ocr_pages INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  duplicate_group TEXT NOT NULL,
  PRIMARY KEY (build_id,id)
);
CREATE INDEX IF NOT EXISTS idx_documents_build_format ON documents(build_id,ext);
CREATE VIRTUAL TABLE IF NOT EXISTS passages_fts USING fts5(
  build_id UNINDEXED, doc_id UNINDEXED, page UNINDEXED, title, body,
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts (
  ip_hash TEXT NOT NULL,
  window INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(ip_hash,window)
);
