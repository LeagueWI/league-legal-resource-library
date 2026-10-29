"""GitHub Actions index builder: R2 -> extraction / Tesseract OCR -> private GitHub
SQLite master index and Cloudflare D1 SQL batches.

Run only on GitHub-hosted runners in a PRIVATE repository. This program
never prints or writes original document text to public logs or web assets.
"""
from __future__ import annotations
import argparse
from collections import defaultdict, Counter
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
from datetime import datetime, timezone

SUPPORTED = {'.pdf', '.docx', '.doc', '.rtf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.msg'}
MAX_BATCH_BYTES = 150_000

def clean_title(key: str) -> str:
    return re.sub(r'[_]+', ' ', Path(key).stem).strip() or 'Untitled resource'

def year_from_key(key: str) -> str:
    for part in Path(key).parts[:-1]:
        m = re.search(r'(?<!\d)(20(?:1\d|2\d))(?!\d)', part)
        if m: return m.group(1)
    return ''

def chunks(text: str, size: int=1150, overlap: int=100):
    txt = re.sub(r'[\t ]+', ' ', text.replace('\x00',' ')).strip()
    pos = 0
    while pos < len(txt):
        end = min(len(txt), pos+size)
        if end < len(txt):
            split = max(txt.rfind('\n',pos+700,end), txt.rfind('. ',pos+700,end))
            if split>pos+650:end=split+1
        if txt[pos:end].strip():yield txt[pos:end].strip()
        if end==len(txt):break
        pos=max(pos+1,end-overlap)

def extract_pdf(path):
    import pymupdf
    import pytesseract
    from PIL import Image
    results=[]; ocr_count=0; needs_ocr=0
    with pymupdf.open(path) as pdf:
        total=len(pdf)
        for idx,page in enumerate(pdf,1):
            raw=page.get_text('text',sort=True).strip()
            should_ocr=(len(raw)<90 and (page.get_images() or len(page.get_drawings())>30)) or (len(raw)<260 and bool(page.get_images()))
            text=raw
            if should_ocr:
                try:
                    pix=page.get_pixmap(matrix=pymupdf.Matrix(2,2),alpha=False)
                    img=Image.frombytes('RGB',[pix.width,pix.height],pix.samples)
                    result=pytesseract.image_to_string(img,lang='eng',config='--psm 3').strip()
                    if result and (len(result)>len(raw)*1.1 or not raw):text=result;ocr_count+=1
                    elif not raw:needs_ocr+=1
                except Exception:
                    if not raw:needs_ocr+=1
            if text:results.append((idx,text))
    return results,total,ocr_count,needs_ocr

def extract_docx(path):
    from docx import Document
    document=Document(path)
    lines=[]
    for block in document.iter_inner_content():
        if hasattr(block,'rows'):
            lines.extend(' | '.join(c.text.replace('\n','; ') for c in row.cells) for row in block.rows)
        elif hasattr(block,'text'):
            if block.text.strip():lines.append(block.text.strip())
    content='\n'.join(lines)
    return ([(0,content)] if content.strip() else []),0,0,0

def extract_doc(path):
    # LibreOffice is installed in GitHub Actions, never on the user's Windows PC.
    with tempfile.TemporaryDirectory() as dest:
        command=['libreoffice','-env:UserInstallation=file:///tmp/lo_legal_index',
                 '--headless','--convert-to','docx','--outdir',dest,str(path)]
        try:
            subprocess.run(command,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=90,check=True)
            result=Path(dest)/(Path(path).stem+'.docx')
            return extract_docx(result) if result.exists() else ([],0,0,0)
        except (subprocess.CalledProcessError,subprocess.TimeoutExpired,FileNotFoundError):
            return [],0,0,0

def extract_image(path):
    from PIL import Image
    import pytesseract
    with Image.open(path) as im:txt=pytesseract.image_to_string(im.convert('RGB'),lang='eng').strip()
    return ([(1,txt)] if txt else []),1,int(bool(txt)),int(not bool(txt))

def extract_file(path):
    ext=path.suffix.lower()
    if ext=='.pdf':return extract_pdf(path)
    if ext=='.docx':return extract_docx(path)
    if ext=='.doc':return extract_doc(path)
    if ext=='.rtf':
        from striprtf.striprtf import rtf_to_text
        content=rtf_to_text(path.read_text(encoding='latin-1',errors='replace')).strip()
        return ([(0,content)] if content else []),0,0,0
    if ext in {'.jpg','.jpeg','.png','.tiff','.tif'}:return extract_image(path)
    return [],0,0,0

def sqlquote(v):
    if v is None:return 'NULL'
    if isinstance(v,(int,float)):return str(v)
    return "'"+str(v).replace("'","''")+"'"

def sqlinsert(table,fields,values):
    return f"INSERT INTO {table}({','.join(fields)}) VALUES ({','.join(sqlquote(v) for v in values)});\n"

class SqlBatchWriter:
    def __init__(self,directory:Path):
        self.directory=directory;directory.mkdir(parents=True,exist_ok=True)
        self.number=0;self.bytes=0;self.file=None;self.paths=[]
    def write(self,line):
        size=len(line.encode('utf-8'))
        if size>MAX_BATCH_BYTES:raise ValueError('SQL record exceeds safe batch size')
        if self.file is None or self.bytes+size>MAX_BATCH_BYTES:
            if self.file:self.file.close()
            self.number+=1
            path=self.directory/f'{self.number:05d}.sql';self.file=path.open('w',encoding='utf-8')
            self.paths.append(path);self.bytes=0
        self.file.write(line);self.bytes+=size
    def close(self):
        if self.file:self.file.close();self.file=None

def setup_master(path):
    con=sqlite3.connect(path)
    con.executescript("""
    CREATE TABLE documents (id TEXT PRIMARY KEY, object_key TEXT NOT NULL,
      title TEXT, ext TEXT, year TEXT, status TEXT, pages INTEGER,
      extracted_chars INTEGER, ocr_pages INTEGER, sha256 TEXT, duplicate_group TEXT);
    CREATE VIRTUAL TABLE passages_fts USING fts5(doc_id UNINDEXED,page UNINDEXED,title,body);
    """)
    return con

def build(client,bucket,out:Path,build_id:str):
    out.mkdir(parents=True,exist_ok=True)
    sql=SqlBatchWriter(out/'sql')
    db=setup_master(out/'search_master.sqlite3')
    counts=Counter();seen={};contents={};doc_records=[];source_passages=[]
    # Files stay in R2. Only temporary copies are downloaded by GitHub Actions.
    with tempfile.TemporaryDirectory(prefix='legal-index-') as temp:
        paginator=client.get_paginator('list_objects_v2')
        for page in paginator.paginate(Bucket=bucket):
            for obj in page.get('Contents',[]):
                key=obj['Key'];ext=Path(key).suffix.lower()
                if ext not in SUPPORTED or Path(key).name.startswith('~$'):continue
                file_id=hashlib.sha256(key.encode('utf-8')).hexdigest()
                file_path=Path(temp)/('source'+ext)
                try:
                    with file_path.open('wb') as fd:client.download_fileobj(bucket,key,fd)
                    content_hash=hashlib.sha256(file_path.read_bytes()).hexdigest()
                    entries,pages,ocr,unreadable=extract_file(file_path)
                    passage_data=[(number,part) for number,text in entries for part in chunks(text)]
                    norm=' '.join(t for _,t in entries).casefold()
                    content_norm_hash=hashlib.sha256(re.sub(r'\s+',' ',norm).encode('utf-8')).hexdigest() if norm else ''
                    record={'id':file_id,'object_key':key,'title':clean_title(key),'ext':ext,
                            'year':year_from_key(key),'status':'searchable' if passage_data else 'title-only',
                            'pages':pages,'extracted_chars':len(norm),'ocr_pages':ocr,'sha256':content_hash,
                            'content_hash':content_norm_hash,'duplicate_group':file_id}
                    doc_records.append(record);source_passages.append((record,passage_data))
                    counts['total']+=1;counts[record['status']]+=1;counts['ocr_pages']+=ocr;counts['pages_unreadable']+=unreadable
                    if content_hash in seen:record['duplicate_group']=seen[content_hash]
                    else:seen[content_hash]=file_id
                    if content_norm_hash and content_norm_hash in contents:
                        record['duplicate_group']=contents[content_norm_hash]
                    elif content_norm_hash:contents[content_norm_hash]=record['duplicate_group']
                except Exception as exc:
                    counts['errors']+=1
                    print('Warning: one resource could not be processed:',type(exc).__name__)
                finally:
                    file_path.unlink(missing_ok=True)
    # Avoid publishing a partial collection on a transient R2 or OCR failure.
    if counts['errors']:
        raise RuntimeError(f"Index failed with {counts['errors']} resource errors; prior published index remains active.")
    if counts['total']==0:raise RuntimeError('No supported resources found. Refusing empty index publication.')
    for record,parts in source_passages:
        fields=['build_id','id','object_key','title','ext','year','status','pages','extracted_chars','ocr_pages','sha256','duplicate_group']
        vals=[build_id]+[record[k] for k in fields[1:]]
        sql.write(sqlinsert('documents',fields,vals))
        db.execute('INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?,?,?)',vals[1:])
        for page,body in parts or [(0,'')]:
            values=[build_id,record['id'],page,record['title'],body]
            sql.write(sqlinsert('passages_fts',['build_id','doc_id','page','title','body'],values))
            db.execute('INSERT INTO passages_fts VALUES (?,?,?,?)',values[1:])
            counts['passages']+=1
    db.commit();db.close();sql.close()
    (out/'activate.sql').write_text(sqlinsert('meta',['key','value'],['live_build',build_id]),encoding='utf-8')
    report={'build_id':build_id,'indexed_utc':datetime.now(timezone.utc).isoformat(),
            'resources':counts['total'],'searchable':counts['searchable'],
            'title_only':counts['title-only'],'ocr_pages':counts['ocr_pages'],
            'unreadable_pages':counts['pages_unreadable'],'passages':counts['passages'],
            'confirmed_duplicate_groups':sum(1 for n in Counter(r['duplicate_group'] for r in doc_records).values() if n>1)}
    (out/'manifest.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print('Index complete:',json.dumps(report))
    return report

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--out',default='build_index');ap.add_argument('--build-id',required=True);args=ap.parse_args()
    for k in ('R2_ENDPOINT','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET'):
        if not os.getenv(k):raise SystemExit(f'Missing required GitHub secret {k}')
    import boto3
    client=boto3.client('s3',endpoint_url=os.environ['R2_ENDPOINT'],region_name='auto',
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'])
    build(client,os.environ['R2_BUCKET'],Path(args.out),args.build_id)
if __name__=='__main__':main()
