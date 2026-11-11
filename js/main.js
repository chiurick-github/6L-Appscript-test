/**
 * Google Apps Script Web App 入口函式
 * 使用 createTemplateFromFile('html/index') 支援在 HTML 中透過 <?!= include('css/style.css'); ?> 載入樣式表
 */
function doGet(e) {
  return HtmlService.createTemplateFromFile('html/index')
    .evaluate()
    .setTitle('6L-Appscript-test Web App')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * 供 HTML 模板載入外部樣式或子頁面 (如 css/style.css.html)
 * 由於 GAS 雲端僅支援 .gs 與 .html，本地端 css/ 目錄下的樣式檔命名為 *.css.html
 * @param {string} filename 例如 'css/style.css' 或 'css/style.css.html'
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getAppStatus() {
  return {
    status: 'ok',
    project: '6L-Appscript-test',
    mode: 'google-apps-script',
    timeZone: Session.getScriptTimeZone(),
    timestamp: new Date().toISOString()
  };
}
