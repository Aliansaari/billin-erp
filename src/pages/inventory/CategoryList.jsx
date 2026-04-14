import React, { useEffect, useState, useRef } from 'react';
import { Input, Modal, Form, Select, message, Spin, Empty, Tooltip } from 'antd';
import { SearchOutlined, PlusOutlined, EditOutlined, DeleteOutlined, TagsOutlined } from '@ant-design/icons';
import { categoryAPI } from '../../api';

const PAGE_SIZE = 60;

export default function CategoryList() {
  const [allData, setAllData]       = useState([]);
  const [displayed, setDisplayed]   = useState([]);
  const [loading, setLoading]       = useState(false);
  const [search, setSearch]         = useState('');
  const [page, setPage]             = useState(1);

  const [formVisible, setFormVisible] = useState(false);
  const [editing, setEditing]         = useState(null);
  const [formLoading, setFormLoading] = useState(false);
  const [form] = Form.useForm();

  const loaderRef = useRef(null);

  useEffect(() => { loadCategories(); }, []);

  /* ── filter locally on search ── */
  useEffect(() => {
    const q = search.toLowerCase();
    const filtered = q
      ? allData.filter(c => (c.category_name || '').toLowerCase().includes(q) || (c.category_code || '').toLowerCase().includes(q))
      : allData;
    setDisplayed(filtered.slice(0, PAGE_SIZE));
    setPage(1);
  }, [search, allData]);

  /* ── infinite scroll ── */
  useEffect(() => {
    const q = search.toLowerCase();
    const filtered = q
      ? allData.filter(c => (c.category_name || '').toLowerCase().includes(q) || (c.category_code || '').toLowerCase().includes(q))
      : allData;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && displayed.length < filtered.length) {
          const next = page + 1;
          setPage(next);
          setDisplayed(filtered.slice(0, next * PAGE_SIZE));
        }
      },
      { threshold: 0.1 }
    );
    if (loaderRef.current) observer.observe(loaderRef.current);
    return () => observer.disconnect();
  }, [displayed, allData, page, search]);

  const loadCategories = async () => {
    setLoading(true);
    try {
      const { data } = await categoryAPI.getAll();
      // Flatten tree into list with parent info
      const flat = [];
      const flatten = (nodes, parentName = null) => {
        (nodes || []).forEach(c => {
          flat.push({ ...c, _parentName: parentName });
          if (c.subCategories?.length) flatten(c.subCategories, c.category_name);
        });
      };
      flatten(data);
      setAllData(flat);
      setDisplayed(flat.slice(0, PAGE_SIZE));
      setPage(1);
    } catch { message.error('Failed to load categories'); }
    setLoading(false);
  };

  const openForm = (cat = null) => {
    setEditing(cat);
    if (cat) form.setFieldsValue({ category_name: cat.category_name, category_code: cat.category_code, parent_category_id: cat.parent_category_id });
    else form.resetFields();
    setFormVisible(true);
  };

  const handleSubmit = async () => {
    setFormLoading(true);
    try {
      const values = await form.validateFields();
      if (editing) {
        await categoryAPI.update(editing.category_id, values);
        message.success('Category updated');
      } else {
        await categoryAPI.create(values);
        message.success('Category created');
      }
      setFormVisible(false);
      setEditing(null);
      await loadCategories();
    } catch (e) { message.error(e.response?.data?.error || 'Failed to save'); }
    setFormLoading(false);
  };

  const handleDelete = (cat) => {
    Modal.confirm({
      title: `Deactivate "${cat.category_name}"?`,
      okText: 'Deactivate', okType: 'danger',
      onOk: async () => {
        try {
          await categoryAPI.delete(cat.category_id);
          message.success('Deactivated');
          loadCategories();
        } catch (e) {
          message.error({ content: e.response?.data?.error || 'Failed to deactivate', duration: 6 });
        }
      },
    });
  };

  // Top-level categories only for parent dropdown
  const topLevel = allData.filter(c => !c.parent_category_id);

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'calc(100vh - 64px)', background:'#f8fafc', overflow:'hidden' }}>

      {/* ── Top bar ── */}
      <div style={{ background:'#fff', borderBottom:'1px solid #e5e7eb', padding:'12px 24px', flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
          {/* Title + count */}
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <span style={{ fontSize:16, fontWeight:700, color:'#111827' }}>Categories</span>
            <span style={{ fontSize:12, background:'#eff6ff', color:'#1d4ed8', borderRadius:20, padding:'3px 12px', fontWeight:600 }}>
              {allData.length} Categories
            </span>
          </div>

          {/* Controls */}
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            <Input
              prefix={<SearchOutlined style={{ color:'#9ca3af' }}/>}
              placeholder="Search categories…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              allowClear
              style={{ width:220 }}
            />
            <button
              onClick={() => openForm()}
              style={{ display:'flex', alignItems:'center', gap:6, background:'#f59e0b', border:'none', borderRadius:8, color:'#fff', fontWeight:700, fontSize:13, padding:'7px 16px', cursor:'pointer' }}
            >
              <PlusOutlined/> Add Category
            </button>
          </div>
        </div>
      </div>

      {/* ── Column headers ── */}
      <div style={{
        display:'grid',
        gridTemplateColumns:'1fr 200px 180px 80px 120px',
        padding:'8px 24px',
        borderBottom:'2px solid #e5e7eb',
        background:'#f9fafb',
        flexShrink:0,
      }}>
        {['Category Name','Code','Parent Category','Sub-cats','Actions'].map(h => (
          <div key={h} style={{ fontSize:11, fontWeight:700, color:'#9ca3af', textTransform:'uppercase', letterSpacing:.5 }}>
            {h}
          </div>
        ))}
      </div>

      {/* ── List ── */}
      <div style={{ flex:1, overflowY:'auto' }}>
        {loading ? (
          <div style={{ display:'flex', justifyContent:'center', padding:60 }}><Spin size="large"/></div>
        ) : allData.length === 0 ? (
          <Empty description="No categories found" style={{ marginTop:60 }}/>
        ) : (
          <>
            {displayed.map((cat, i) => {
              const isSubCat = !!cat.parent_category_id;
              return (
                <div
                  key={cat.category_id}
                  style={{
                    display:'grid',
                    gridTemplateColumns:'1fr 200px 180px 80px 120px',
                    padding:'10px 24px',
                    borderBottom:'1px solid #f3f4f6',
                    background: i % 2 === 0 ? '#fff' : '#fafafa',
                    alignItems:'center',
                    transition:'background .1s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background='#eff6ff'}
                  onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? '#fff' : '#fafafa'}
                >
                  {/* Category Name */}
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    {isSubCat && <span style={{ width:16, color:'#d1d5db', fontSize:12 }}>↳</span>}
                    <TagsOutlined style={{ color: isSubCat ? '#a78bfa' : '#6366f1', fontSize:14 }}/>
                    <span style={{ fontSize:13, fontWeight: isSubCat ? 400 : 600, color:'#111827', marginLeft: isSubCat ? 0 : 4 }}>
                      {cat.category_name}
                    </span>
                  </div>

                  {/* Code */}
                  <div style={{ fontSize:13, color:'#6b7280' }}>{cat.category_code || '—'}</div>

                  {/* Parent */}
                  <div style={{ fontSize:13, color:'#6b7280' }}>
                    {cat._parentName
                      ? <span style={{ background:'#f3f4f6', borderRadius:6, padding:'2px 8px', fontSize:12 }}>{cat._parentName}</span>
                      : <span style={{ color:'#d1d5db' }}>—</span>
                    }
                  </div>

                  {/* Sub-cat count */}
                  <div style={{ fontSize:13, color:'#6b7280' }}>
                    {cat.subCategories?.length > 0
                      ? <span style={{ background:'#ede9fe', color:'#6d28d9', borderRadius:6, padding:'2px 8px', fontSize:12, fontWeight:600 }}>{cat.subCategories.length}</span>
                      : <span style={{ color:'#d1d5db' }}>—</span>
                    }
                  </div>

                  {/* Actions */}
                  <div style={{ display:'flex', gap:6 }}>
                    <Tooltip title="Edit">
                      <button
                        onClick={() => openForm(cat)}
                        style={{ background:'#eff6ff', border:'none', borderRadius:6, cursor:'pointer', padding:'5px 10px', color:'#2563eb', display:'flex', alignItems:'center' }}
                      >
                        <EditOutlined/>
                      </button>
                    </Tooltip>
                    <Tooltip title="Deactivate">
                      <button
                        onClick={() => handleDelete(cat)}
                        style={{ background:'#fef2f2', border:'none', borderRadius:6, cursor:'pointer', padding:'5px 10px', color:'#dc2626', display:'flex', alignItems:'center' }}
                      >
                        <DeleteOutlined/>
                      </button>
                    </Tooltip>
                  </div>
                </div>
              );
            })}

            {/* Sentinel */}
            <div ref={loaderRef} style={{ padding:16, textAlign:'center' }}>
              {displayed.length < allData.length
                ? <Spin size="small"/>
                : <span style={{ fontSize:12, color:'#9ca3af' }}>All {allData.length} categories loaded</span>
              }
            </div>
          </>
        )}
      </div>

      {/* ── Add / Edit Modal ── */}
      <Modal
        title={editing ? `Edit — ${editing.category_name}` : 'Add Category'}
        open={formVisible}
        onCancel={() => { setFormVisible(false); setEditing(null); }}
        onOk={handleSubmit}
        confirmLoading={formLoading}
        okText={editing ? 'Update' : 'Add Category'}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop:8 }}>
          <Form.Item name="category_name" label="Category Name" rules={[{ required:true, message:'Required' }]}>
            <Input placeholder="e.g. Frock, Jeans, T-Shirt" autoFocus/>
          </Form.Item>
          <Form.Item name="category_code" label="Category Code">
            <Input placeholder="Optional short code"/>
          </Form.Item>
          <Form.Item name="parent_category_id" label="Parent Category">
            <Select placeholder="None (top-level)" allowClear>
              {topLevel
                .filter(c => c.category_id !== editing?.category_id)
                .map(c => <Select.Option key={c.category_id} value={c.category_id}>{c.category_name}</Select.Option>)
              }
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
