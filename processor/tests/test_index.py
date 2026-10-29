import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from index_r2 import clean_title,year_from_key,chunks,sqlquote,SqlBatchWriter

def test_year():assert year_from_key('2023/Employees/myfile.pdf')=='2023'
def test_title():assert clean_title('2024/My_Legal_Resource.pdf')=='My Legal Resource'
def test_chunks():
    s='Municipal authority and public records. '*100
    out=list(chunks(s,240,20));assert len(out)>1;assert 'public records' in out[0]
def test_escaping():assert sqlquote("Council's law") == "'Council''s law'"
def test_batch(tmp_path):
    b=SqlBatchWriter(tmp_path)
    b.write("SELECT 1;\n");b.close();assert (tmp_path/'00001.sql').read_text()=='SELECT 1;\n'
