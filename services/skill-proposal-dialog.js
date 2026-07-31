/**
 * 技能提案对话框 - 使用现有的 app-modal 系统
 * 
 * 复用现有的 .app-modal-layer 和 .app-modal-panel 样式
 * 无需创建新的 CSS 文件
 */

const api = window.heiqiu;

/**
 * 显示技能提案对话框
 * @param {Object} pattern - 技能模式对象
 * @returns {Promise<boolean>} 用户是否确认
 */
async function showSkillProposalDialog(pattern) {
  return new Promise((resolve) => {
    const layer = document.createElement("div");
    layer.className = "app-modal-layer skill-proposal-layer";
    
    // 构建步骤HTML
    const stepsHtml = pattern.steps.map(step => `
      <div class="skill-step">
        <span class="step-num">${step.order}</span>
        <code class="step-tool">${escapeHtml(step.toolId)}</code>
      </div>
    `).join("");
    
    // 构建触发词HTML
    const keywordsHtml = pattern.triggerKeywords.map(kw => 
      `<span class="keyword-tag">${escapeHtml(kw)}</span>`
    ).join("");
    
    layer.innerHTML = `
      <div class="app-modal-panel skill-proposal-panel" role="dialog" aria-modal="true">
        <div class="skill-header">
          <span class="skill-icon">💡</span>
          <strong>发现可复用模式</strong>
        </div>
        
        <p class="skill-intro">我注意到您经常执行以下操作：</p>
        
        <div class="skill-preview">
          <div class="skill-name-section">
            <label>技能名称：</label>
            <input 
              type="text" 
              class="skill-name-input" 
              value="${escapeHtml(pattern.name)}"
              placeholder="例如: skill_get_desktop_report"
            />
          </div>
          
          <div class="skill-description">
            <strong>任务描述：</strong>
            <p>${escapeHtml(pattern.description)}</p>
          </div>
          
          <div class="skill-steps">
            <strong>执行步骤：</strong>
            <div class="steps-list">
              ${stepsHtml}
            </div>
          </div>
          
          <div class="skill-keywords">
            <strong>触发关键词：</strong>
            <div class="keywords-list">
              ${keywordsHtml}
            </div>
            <div class="keywords-edit">
              <input 
                type="text" 
                class="keywords-input" 
                value="${escapeHtml(pattern.triggerKeywords.join(', '))}"
                placeholder="用逗号分隔，例如: 桌面报告, 文件摘要"
              />
            </div>
          </div>
        </div>
        
        <div class="app-modal-actions skill-actions">
          <button class="btn-ignore" type="button">❌ 忽略</button>
          <button class="btn-confirm" type="button">💾 保存为技能</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(layer);
    
    // 获取输入元素
    const nameInput = layer.querySelector(".skill-name-input");
    const keywordsInput = layer.querySelector(".keywords-input");
    const buttons = layer.querySelectorAll(".app-modal-actions button");
    const ignoreBtn = buttons[0];
    const confirmBtn = buttons[1];
    
    // 忽略按钮
    ignoreBtn.addEventListener("click", async () => {
      await api.invoke('skill:reject', pattern.id, '用户拒绝');
      layer.remove();
      resolve(false);
    });
    
    // 确认按钮
    confirmBtn.addEventListener("click", async () => {
      const newName = nameInput.value.trim();
      const newKeywords = keywordsInput.value
        .split(/[,，]/)
        .map(k => k.trim())
        .filter(Boolean);
      
      if (!newName) {
        alert("请输入技能名称");
        nameInput.focus();
        return;
      }
      
      confirmBtn.disabled = true;
      confirmBtn.textContent = "安装中...";
      
      try {
        const result = await api.invoke('skill:confirm', pattern.id, {
          name: newName,
          triggerKeywords: newKeywords
        });
        
        if (result.success) {
          alert(result.message);
          layer.remove();
          resolve(true);
        } else {
          alert(`安装失败: ${result.error}`);
          confirmBtn.disabled = false;
          confirmBtn.textContent = "💾 保存为技能";
        }
      } catch (error) {
        alert(`安装失败: ${error.message}`);
        confirmBtn.disabled = false;
        confirmBtn.textContent = "💾 保存为技能";
      }
    });
    
    // ESC 键关闭
    layer.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        ignoreBtn.click();
      }
    });
    
    // 点击背景关闭
    layer.addEventListener("click", (e) => {
      if (e.target === layer) {
        ignoreBtn.click();
      }
    });
    
    // 自动聚焦到名称输入框
    setTimeout(() => nameInput.focus(), 100);
  });
}

/**
 * HTML转义
 */
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// 导出函数
window.showSkillProposalDialog = showSkillProposalDialog;
