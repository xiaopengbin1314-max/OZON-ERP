/** 我的图库与 AI 图片生成。 */
let galleryAssets = [];
let galleryFilter = { keyword: '', source: '', favorite: '' };

function renderGalleryPage() {
  setTimeout(loadGalleryAssets, 0);
  return `
    <div class="media-page">
      <div class="media-page-head">
        <div><h2>我的图库</h2><p>集中管理商品图片与 AI 创作素材</p></div>
        <div class="media-head-actions">
          <input id="galleryFileInput" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onchange="uploadGalleryFiles(this.files)">
          <button class="btn btn-sm btn-ghost" onclick="document.getElementById('galleryFileInput').click()"><i data-lucide="upload"></i> 上传图片</button>
          <button class="btn btn-sm btn-primary" onclick="Router.navigate('/ai-image')"><i data-lucide="sparkles"></i> AI 生成</button>
        </div>
      </div>
      <div class="media-toolbar">
        <div class="media-search"><i data-lucide="search"></i><input id="gallerySearch" placeholder="搜索名称、标签或提示词" oninput="debounceGallerySearch(this.value)"></div>
        <div class="media-segments">
          <button class="active" data-source="" onclick="setGallerySource(this,'')">全部</button>
          <button data-source="upload" onclick="setGallerySource(this,'upload')">上传</button>
          <button data-source="ai" onclick="setGallerySource(this,'ai')">AI 生成</button>
          <button data-source="favorite" onclick="setGallerySource(this,'favorite')"><i data-lucide="star"></i> 收藏</button>
        </div>
        <span class="media-count" id="galleryCount">0 张</span>
      </div>
      <div class="gallery-grid" id="galleryGrid"><div class="media-loading">正在读取图库...</div></div>
    </div>`;
}

function renderAIImagePage() {
  setTimeout(() => { loadAIGenerationHistory(); Api.getAIModelsStatus().then(showImageModelStatus); }, 0);
  return `
    <div class="media-page ai-image-page">
      <div class="media-page-head">
        <div><h2>AI 图片生成</h2><p>生成结果自动进入我的图库</p></div>
        <button class="btn btn-sm btn-ghost" onclick="Router.navigate('/gallery')"><i data-lucide="images"></i> 我的图库</button>
      </div>
      <div class="ai-image-workspace">
        <aside class="ai-image-controls">
          <div class="ai-model-state" id="aiImageModelState"><span class="state-dot"></span><span>正在读取模型配置...</span></div>
          <label class="media-label">图片描述</label>
          <textarea id="aiImagePrompt" class="form-textarea" rows="8" maxlength="2000" placeholder="例如：白色背景中的黑色全自动防风雨伞，商品摄影，完整展示伞面与手柄，柔和棚拍光线，无文字"></textarea>
          <div class="media-form-row">
            <div><label class="media-label">画面比例</label><select id="aiImageSize" class="form-select"><option value="1024x1024">1:1 方图</option><option value="1024x1536">2:3 竖图</option><option value="1536x1024">3:2 横图</option></select></div>
            <div><label class="media-label">生成数量</label><select id="aiImageCount" class="form-select"><option value="1">1 张</option><option value="2">2 张</option><option value="4">4 张</option></select></div>
          </div>
          <label class="media-label">图片模型</label>
          <input id="aiImageModel" class="form-input" value="gpt-image-1" placeholder="如 gpt-image-1">
          <button id="generateImageBtn" class="btn btn-primary ai-generate-btn" onclick="generateAIImage()"><i data-lucide="wand-sparkles"></i> 开始生成</button>
        </aside>
        <section class="ai-image-results">
          <div class="media-section-title"><div><h3>生成结果</h3><span>点击图片查看详情</span></div></div>
          <div class="gallery-grid ai-results-grid" id="aiImageResults"><div class="media-empty"><i data-lucide="image-plus"></i><strong>等待创作</strong><span>输入商品与场景描述开始生成</span></div></div>
        </section>
      </div>
    </div>`;
}

async function loadGalleryAssets() {
  const response = await Api.getGallery(galleryFilter);
  galleryAssets = response?.code === 200 ? (response.data?.list || []) : [];
  renderGalleryGrid('galleryGrid', galleryAssets);
  const count = document.getElementById('galleryCount');
  if (count) count.textContent = `${galleryAssets.length} 张`;
}

function galleryCard(asset) {
  const tags = (asset.tags || []).slice(0, 2).map(tag => `<span>${escapeHtml(tag)}</span>`).join('');
  return `<article class="gallery-item" data-id="${asset.id}">
    <button class="gallery-preview" onclick="showGalleryAsset('${asset.id}')"><img src="${escapeAttr(asset.url)}" alt="${escapeAttr(asset.title)}" loading="lazy"></button>
    <div class="gallery-meta"><div><strong title="${escapeAttr(asset.title)}">${escapeHtml(asset.title)}</strong><small>${asset.source === 'ai' ? 'AI 生成' : '本地上传'} · ${formatFileSize(asset.file_size)}</small></div>
      <button class="gallery-star ${asset.favorite ? 'active' : ''}" title="收藏" onclick="toggleGalleryFavorite('${asset.id}')"><i data-lucide="star"></i></button></div>
    ${tags ? `<div class="gallery-tags">${tags}</div>` : ''}
    <div class="gallery-actions"><button onclick="copyGalleryUrl('${asset.id}')" title="复制链接"><i data-lucide="link"></i></button><a href="${escapeAttr(asset.url)}" download title="下载"><i data-lucide="download"></i></a><button class="danger" onclick="deleteGalleryItem('${asset.id}')" title="删除"><i data-lucide="trash-2"></i></button></div>
  </article>`;
}

function renderGalleryGrid(targetId, assets) {
  const target = document.getElementById(targetId); if (!target) return;
  target.innerHTML = assets.length ? assets.map(galleryCard).join('') : `<div class="media-empty"><i data-lucide="images"></i><strong>暂无图片</strong><span>上传图片或使用 AI 生成后会显示在这里</span></div>`;
  if (window.lucide) lucide.createIcons();
}

async function uploadGalleryFiles(files) {
  if (!files?.length) return;
  Toast.show(`正在上传 ${files.length} 张图片...`, 'info');
  const response = await Api.uploadGallery(files);
  if (response?.code !== 200) return Toast.show(response?.msg || '上传失败', 'error');
  Toast.show(response.msg || '上传成功', 'success'); await loadGalleryAssets();
}

function setGallerySource(button, source) {
  document.querySelectorAll('.media-segments button').forEach(item => item.classList.remove('active')); button.classList.add('active');
  galleryFilter.source = source === 'favorite' ? '' : source; galleryFilter.favorite = source === 'favorite' ? '1' : ''; loadGalleryAssets();
}
let gallerySearchTimer;
function debounceGallerySearch(value) { clearTimeout(gallerySearchTimer); gallerySearchTimer = setTimeout(() => { galleryFilter.keyword = value.trim(); loadGalleryAssets(); }, 300); }
function findGalleryAsset(id) { return galleryAssets.find(item => String(item.id) === String(id)); }
async function toggleGalleryFavorite(id) { const item=findGalleryAsset(id); if(!item)return; await Api.updateGalleryAsset(id,{favorite:!item.favorite}); loadGalleryAssets(); }
async function copyGalleryUrl(id) { const item=findGalleryAsset(id); if(!item)return; await navigator.clipboard.writeText(new URL(item.url, location.origin).href); Toast.show('图片链接已复制','success'); }
async function deleteGalleryItem(id) { if(!await Modal.confirm('确定删除这张图片吗？'))return; const r=await Api.deleteGalleryAsset(id); if(r?.code===200){Toast.show('图片已删除','success');loadGalleryAssets();}else Toast.show(r?.msg||'删除失败','error'); }
function formatFileSize(bytes){const n=Number(bytes||0);return n>=1048576?(n/1048576).toFixed(1)+' MB':Math.max(1,Math.round(n/1024))+' KB';}

function showGalleryAsset(id) {
  const item=findGalleryAsset(id); if(!item)return;
  Modal.show({title:item.title,size:'lg',body:`<div class="gallery-detail"><img src="${escapeAttr(item.url)}" alt=""><div><p><b>来源</b>${item.source==='ai'?'AI 生成':'本地上传'}</p><p><b>文件大小</b>${formatFileSize(item.file_size)}</p><p><b>创建时间</b>${item.created_at}</p>${item.prompt?`<p><b>提示词</b>${escapeHtml(item.prompt)}</p>`:''}</div></div>`,footer:[{text:'关闭',class:'btn-ghost'},{text:'复制链接',class:'btn-primary',onClick:()=>copyGalleryUrl(id)}]});
}

function showImageModelStatus(response) { const el=document.getElementById('aiImageModelState');if(!el)return;const ok=response?.code===200&&response.data?.has_key;el.classList.toggle('ready',ok);el.innerHTML=`<span class="state-dot"></span><span>${ok?`${escapeHtml(response.data.name||response.data.provider)} 已配置`:'未配置图片 API，请前往模型管理'}</span>`; }
async function loadAIGenerationHistory(){const r=await Api.getGallery({source:'ai'});const items=r?.code===200?(r.data?.list||[]):[];galleryAssets=items;renderGalleryGrid('aiImageResults',items);}
async function generateAIImage(){const prompt=document.getElementById('aiImagePrompt').value.trim();if(!prompt)return Toast.show('请输入图片描述','warning');const btn=document.getElementById('generateImageBtn');btn.disabled=true;btn.innerHTML='<span class="media-spinner"></span> 正在生成';const r=await Api.generateAIImages({prompt,size:document.getElementById('aiImageSize').value,count:Number(document.getElementById('aiImageCount').value),model:document.getElementById('aiImageModel').value.trim()});btn.disabled=false;btn.innerHTML='<i data-lucide="wand-sparkles"></i> 开始生成';if(window.lucide)lucide.createIcons();if(r?.code!==200)return Toast.show(r?.msg||'生成失败','error');Toast.show(r.msg||'生成完成','success');await loadAIGenerationHistory();}

Router.register('/gallery', renderGalleryPage);
Router.register('/ai-image', renderAIImagePage);
