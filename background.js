// -*- coding: utf-8 -*-

let isRunning = false;
let shouldStop = false;
let logEntries = [];
let activeRunId = 0;
let activeTabId = null;
let originalTitle = '';
let lastListDetails = '미확인';
let titleErrorLogged = false;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startMacro') {
    if (isRunning) {
      sendResponse({success: false, error: '이미 매크로가 실행 중입니다.'});
      return;
    }

    const count = Number(request.count);
    const minDelay = Number(request.minDelay);
    const maxDelay = Number(request.maxDelay);
    if (!Number.isInteger(count) || count < 0 || count > 10000) {
      sendResponse({success: false, error: '반복 횟수는 0~10,000 사이의 정수여야 합니다.'});
      return;
    }
    if (!Number.isFinite(minDelay) || !Number.isFinite(maxDelay) ||
        minDelay < 0.5 || maxDelay > 30 || minDelay > maxDelay) {
      sendResponse({success: false, error: '반복 주기는 0.5~30초이며 최소값이 최대값보다 클 수 없습니다.'});
      return;
    }

    const runId = ++activeRunId;
    isRunning = true;
    shouldStop = false;
    startMacroBackground(count, minDelay, maxDelay, runId);
    sendResponse({success: true});
  } else if (request.action === 'stopMacro') {
    shouldStop = true;
    sendResponse({success: true});
  } else if (request.action === 'getStatus') {
    sendResponse({isRunning});
  }
});

async function startMacroBackground(count, minDelaySeconds, maxDelaySeconds, runId) {
  logEntries = [];
  const isInfinite = count === 0;
  const totalLabel = isInfinite ? '∞' : count;
  const actionTimeout = 15000;

  addLog('========== 시작 ==========', 'info');
  addLog(
    `반복 횟수: ${isInfinite ? '무한(중지 시까지)' : count}, ` +
    `랜덤 반복 주기: ${minDelaySeconds}~${maxDelaySeconds}초`,
    'info'
  );
  notifyPopup(`⏳ 반복 1/${totalLabel} 진행 중...`, 'running', true);

  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab?.id) {
      throw new Error('현재 탭을 찾을 수 없습니다.');
    }

    activeTabId = tab.id;
    if (!isApplePage(tab.url)) {
      throw new Error('Apple 구독 관리 페이지를 연 뒤 다시 실행하세요.');
    }

    let completedCount = 0;
    originalTitle = tab.title || '';

    mainLoop: while (isInfinite || completedCount < count) {
      if (isStopped(runId)) break;
      const currentNumber = completedCount + 1;

      addLog(`[${currentNumber}/${totalLabel}] 반복 시작...`, 'info');
      await setTabTitle(tab.id, `${completedCount}/${totalLabel} (진행 중)`);
      notifyPopup(`⏳ 반복 ${currentNumber}/${totalLabel} 진행 중...`, 'running', true);

      try {
        addLog('  └─ Step 1: YouTube Renew 버튼 대기 중 (최대 15초)...', 'info');
        if (!(await waitForTabAction(tab.id, 'clickRenew', runId, actionTimeout))) break mainLoop;
        addLog('  └─ Step 1: Renew 버튼 클릭 완료', 'success');

        addLog('  └─ Step 2: Confirm 버튼 대기 중 (최대 15초)...', 'info');
        if (!(await waitForTabAction(tab.id, 'clickConfirm', runId, actionTimeout))) break mainLoop;
        addLog('  └─ Step 2: Confirm 버튼 클릭 완료', 'success');

        addLog('  └─ Step 3: 결제 오류와 Cancel 버튼 대기 중 (최대 15초)...', 'info');
        if (!(await waitForTabAction(tab.id, 'checkError', runId, actionTimeout))) break mainLoop;
        addLog('  └─ ⚠️ 결제 오류 감지 → Cancel 클릭 완료', 'warning');

        completedCount++;
        addLog(`[${currentNumber}/${totalLabel}] 완료✓`, 'success');

        if (isInfinite || completedCount < count) {
          const randomDelay = getRandomDelayMs(minDelaySeconds, maxDelaySeconds);
          const randomDelayLabel = formatDelaySeconds(randomDelay);
          addLog(`  └─ 다음 반복까지 ${randomDelayLabel}초 대기`, 'info');
          notifyPopup(
            `⏳ ${completedCount}/${totalLabel} 완료 · 다음 반복까지 ${randomDelayLabel}초`,
            'running',
            true
          );
          const tickTitle = remainingMs =>
            setTabTitle(tab.id, `${completedCount}/${totalLabel} (${(remainingMs / 1000).toFixed(1)}초)`);
          if (!(await waitWithStop(randomDelay, runId, tickTitle))) break mainLoop;
        }
      } catch (error) {
        if (isStopped(runId)) break;

        if (error.code === 'LIST_PAGE') {
          addLog(`  └─ 🔁 ${error.message} · 이번 반복을 Step 1부터 다시 시작합니다.`, 'warning');
          notifyPopup(`🔁 ${currentNumber}/${totalLabel} 구독 목록 복귀 → 다시 시작`, 'running', true);
          if (!(await waitWithStop(1500, runId))) break mainLoop;
          continue mainLoop;
        }

        if (error.code !== 'ACTION_TIMEOUT') throw error;

        addLog(`  └─ ⚠️ ${error.message}`, 'warning');
        addLog('  └─ 페이지 전체 새로고침 후 같은 반복을 다시 시작합니다.', 'warning');
        notifyPopup(`🔄 ${currentNumber}/${totalLabel} 화면 복구 중...`, 'running', true);

        if (!(await reloadTabAndWait(tab.id, runId))) break;
        addLog('  └─ 페이지 새로고침 완료', 'success');
      }
    }

    if (!isStopped(runId)) {
      addLog('========== 완료 ==========', 'success');
      addLog(`총 ${count}회 반복 완료`, 'success');
      notifyPopup(`✅ 완료! ${count}회 반복 실행됨`, 'success', false);
    } else {
      addLog('========== 사용자 중지 ==========', 'warning');
      notifyPopup('🛑 사용자가 중지했습니다', 'error', false);
    }
  } catch (error) {
    addLog(`❌ 오류: ${error.message}`, 'error');
    notifyPopup(`❌ 오류: ${error.message}`, 'error', false);
  } finally {
    if (activeTabId !== null && originalTitle) {
      await restoreTabTitle(activeTabId, originalTitle);
    }
    if (runId === activeRunId) {
      isRunning = false;
      shouldStop = false;
    }
    saveLogs();
  }
}

function getRandomDelayMs(minDelaySeconds, maxDelaySeconds) {
  const minMs = Math.ceil(minDelaySeconds * 1000);
  const maxMs = Math.floor(maxDelaySeconds * 1000);
  if (maxMs <= minMs) return minMs;
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

function formatDelaySeconds(delayMs) {
  return (delayMs / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function isApplePage(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname === 'apple.com' || hostname.endsWith('.apple.com');
  } catch {
    return false;
  }
}

function isStopped(runId) {
  return shouldStop || runId !== activeRunId;
}

// 종료 시 원래 제목으로 복원하고 감시를 해제한다.
async function restoreTabTitle(tabId, title) {
  try {
    await chrome.scripting.executeScript({
      target: {tabId},
      func: text => {
        window.__macroTitle = null;
        if (window.__macroTitleObserver) {
          window.__macroTitleObserver.disconnect();
          window.__macroTitleObserver = null;
        }
        document.title = text;
      },
      args: [title]
    });
  } catch {
    // 무시
  }
}

async function setTabTitle(tabId, status) {
  // 원래 탭 이름을 앞에 남기고 " - 상태" 형태로 표시
  const title = originalTitle ? `${originalTitle} - ${status}` : status;
  try {
    await chrome.scripting.executeScript({
      target: {tabId},
      func: text => {
        // 페이지(SPA)가 제목을 되돌려도 다시 덮어쓰도록 <title>을 감시한다.
        window.__macroTitle = text;
        const apply = () => {
          if (window.__macroTitle && document.title !== window.__macroTitle) {
            document.title = window.__macroTitle;
          }
        };
        if (!window.__macroTitleObserver) {
          let titleEl = document.querySelector('title');
          if (!titleEl) {
            titleEl = document.createElement('title');
            (document.head || document.documentElement).appendChild(titleEl);
          }
          window.__macroTitleObserver = new MutationObserver(apply);
          window.__macroTitleObserver.observe(titleEl, {childList: true, characterData: true, subtree: true});
        }
        apply();
      },
      args: [title]
    });
    titleErrorLogged = false;
  } catch (error) {
    // 탭이 이동/로딩 중일 수 있으므로 중단하진 않되, 원인 파악을 위해 연속 실패 시 한 번만 기록
    if (!titleErrorLogged) {
      titleErrorLogged = true;
      addLog(`⚠️ 탭 제목 변경 실패: ${error.message}`, 'warning');
    }
  }
}

async function waitWithStop(ms, runId, onTick) {
  const endAt = Date.now() + ms;
  let nextKeepAliveAt = Date.now() + 20000;
  while (Date.now() < endAt) {
    if (isStopped(runId)) return false;
    if (onTick) await onTick(endAt - Date.now());
    if (Date.now() >= nextKeepAliveAt) {
      await chrome.runtime.getPlatformInfo();
      nextKeepAliveAt = Date.now() + 20000;
    }
    // onTick(카운트다운 표시)이 있으면 0.1초 간격으로 갱신, 없으면 기존처럼 0.25초
    await sleep(Math.min(onTick ? 100 : 250, endAt - Date.now()));
  }
  return !isStopped(runId);
}

async function waitForTabAction(tabId, action, runId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastDetails = '접근 가능한 프레임 없음';

  while (Date.now() < deadline) {
    if (isStopped(runId)) return false;

    const attempt = await tryExecuteTabAction(tabId, action);
    if (attempt.found) return true;
    lastDetails = attempt.details || lastDetails;

    // 구독 목록 화면으로 튕겼다면 YouTube 카드를 다시 눌러 루프를 처음(Step 1)부터 재시작
    if (await tryOpenYoutubeCard(tabId)) {
      const listError = new Error('구독 목록 화면 감지 → YouTube 카드 클릭');
      listError.code = 'LIST_PAGE';
      throw listError;
    }

    const remaining = deadline - Date.now();
    if (remaining > 0 && !(await waitWithStop(Math.min(250, remaining), runId))) {
      return false;
    }
  }

  const actionName = action === 'clickRenew'
    ? 'YouTube Renew 버튼'
    : action === 'clickConfirm'
      ? 'Confirm 버튼'
      : '결제 오류와 Cancel 버튼';
  const error = new Error(`${actionName}을(를) 15초 동안 찾지 못했습니다. 탐색 결과: ${lastDetails} / 목록 화면 판정: ${lastListDetails}`);
  error.code = 'ACTION_TIMEOUT';
  throw error;
}

async function tryOpenYoutubeCard(tabId) {
  try {
    const attempt = await tryExecuteTabAction(tabId, 'clickYoutubeCard');
    if (!attempt.found) lastListDetails = attempt.details;
    return attempt.found;
  } catch {
    return false;
  }
}

async function tryExecuteTabAction(tabId, action) {
  let inspections;

  try {
    inspections = await chrome.scripting.executeScript({
      target: {tabId, allFrames: true},
      func: performPageAction,
      args: [action, false]
    });
  } catch (error) {
    throw new Error(`Apple 페이지에 접근할 수 없습니다: ${error.message}`);
  }

  if (action === 'checkError') {
    const errorFrame = inspections.find(({result}) => result?.hasError);
    if (!errorFrame) {
      return {found: false, details: formatFrameDetails(inspections)};
    }

    if (!errorFrame.result.canClick) {
      return {found: false, details: formatFrameDetails(inspections)};
    }

    const [clickResult] = await chrome.scripting.executeScript({
      target: {tabId, frameIds: [errorFrame.frameId]},
      func: performPageAction,
      args: [action, true]
    });

    if (!clickResult?.result?.success) {
      return {found: false, details: formatFrameDetails(inspections)};
    }
    return {found: true, details: formatFrameDetails(inspections)};
  }

  const targetFrame = inspections.find(({result}) => result?.found);
  if (!targetFrame) {
    return {found: false, details: formatFrameDetails(inspections)};
  }

  const [clickResult] = await chrome.scripting.executeScript({
    target: {tabId, frameIds: [targetFrame.frameId]},
    func: performPageAction,
    args: [action, true]
  });

  if (!clickResult?.result?.success) {
    return {found: false, details: formatFrameDetails(inspections)};
  }
  return {found: true, details: formatFrameDetails(inspections)};
}

function formatFrameDetails(inspections) {
  return inspections
    .map(({result}) => result)
    .filter(Boolean)
    .map(result => `${result.frame || 'unknown'} [${(result.buttons || []).join(', ') || '버튼 없음'}]${result.listReason ? ` (${result.listReason})` : ''}`)
    .join(' / ') || '접근 가능한 프레임 없음';
}

async function reloadTabAndWait(tabId, runId) {
  await chrome.tabs.reload(tabId, {bypassCache: true});
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    if (isStopped(runId)) return false;
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') {
      return waitWithStop(1000, runId);
    }
    if (!(await waitWithStop(250, runId))) return false;
  }

  throw new Error('페이지를 새로고침했지만 30초 안에 로딩이 완료되지 않았습니다.');
}

// 이 함수는 Apple 페이지 안에서 실행되므로 외부 변수에 의존하지 않아야 한다.
function performPageAction(action, shouldClick) {
  const normalize = value => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const isVisible = element => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 && rect.height > 0;
  };

  const roots = [];
  const collectRoots = root => {
    roots.push(root);
    root.querySelectorAll('*').forEach(element => {
      if (element.shadowRoot) collectRoots(element.shadowRoot);
    });
  };
  collectRoots(document);

  const queryAll = selector => roots.flatMap(root => Array.from(root.querySelectorAll(selector)));
  const buttonText = button => normalize(button.textContent || button.getAttribute('aria-label'));
  const usableButton = button => isVisible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
  const visibleButtonTexts = () => Array.from(new Set(
    queryAll('button, [role="button"]')
      .filter(usableButton)
      .map(buttonText)
      .filter(Boolean)
  )).slice(0, 15);
  const diagnostic = () => ({frame: location.hostname, buttons: visibleButtonTexts()});

  const findButton = (selectors, textCandidates, scope = null) => {
    const scopeRoots = scope ? [scope] : roots;
    for (const root of scopeRoots) {
      for (const selector of selectors) {
        const button = root.querySelector(selector);
        if (usableButton(button)) return button;
      }
    }

    const candidates = scope
      ? Array.from(scope.querySelectorAll('button, [role="button"]'))
      : queryAll('button, [role="button"]');
    return candidates.find(button => {
      const text = buttonText(button);
      return usableButton(button) && textCandidates.some(candidate => text === candidate || text.includes(candidate));
    }) || null;
  };

  const click = button => {
    if (!shouldClick) return true;
    button.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'});
    button.focus({preventScroll: true});
    button.click();
    return true;
  };

  const renewSelectors = [
    'button[data-test="action-cta"]',
    '[data-test="action-cta"] button',
    'button[data-testid="action-cta"]',
    'button[name="renew"]',
    'button[aria-label*="Renew" i]',
    'button[aria-label*="Resubscribe" i]',
    'button[data-test*="renew" i]',
    'button[data-test*="resubscribe" i]',
    'button[data-testid*="renew" i]',
    'button[data-testid*="resubscribe" i]'
  ];
  const renewTexts = [
    'renew',
    'renew subscription',
    'resubscribe',
    'subscribe again',
    '갱신',
    '연장',
    '구독 갱신',
    '구독 연장',
    '다시 구독',
    '재구독'
  ];

  if (action === 'clickRenew') {
    let button = null;
    const youtubeLabels = queryAll('h1, h2, h3, h4, p, span, [role="heading"]')
      .filter(element => isVisible(element) && normalize(element.textContent).includes('youtube'))
      .sort((a, b) => normalize(a.textContent).length - normalize(b.textContent).length);

    for (const label of youtubeLabels) {
      let container = label;
      for (let depth = 0; container && depth < 8; depth++, container = container.parentElement) {
        button = findButton(renewSelectors, renewTexts, container);
        if (button) break;
      }
      if (button) break;
    }

    button ||= findButton(renewSelectors, renewTexts);
    if (!button) return {found: false, success: false, ...diagnostic()};
    click(button);
    return {found: true, success: true, text: buttonText(button), ...diagnostic()};
  }

  if (action === 'clickYoutubeCard') {
    // 모달/결제 오류 창이 떠 있으면 목록 화면이 아니므로 건드리지 않는다.
    const modalOpen = queryAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]').some(isVisible);
    if (modalOpen) return {found: false, success: false, ...diagnostic(), listReason: '모달이 열려 있음'};

    // Renew/Confirm 버튼이 보이면 상세 화면이다.
    const onDetailPage = findButton(renewSelectors, renewTexts) ||
      findButton(['button[data-test="button-confirm"]'], ['confirm']);
    if (onDetailPage) return {found: false, success: false, ...diagnostic(), listReason: '상세 화면(Renew/Confirm 버튼 보임)'};

    // 구독 목록 영역이 실제로 보일 때만 목록 화면으로 인정한다(다른 프레임/팝업 오탐 방지).
    const listSection = queryAll('[data-test="subscriptions-list-section"], [data-test="subscription-list-group"]').find(isVisible);
    if (!listSection) return {found: false, success: false, ...diagnostic(), listReason: '구독 목록 영역 없음'};

    const youtubeWords = ['youtube', '유튜브'];
    // 'youtube'가 들어간 보이는 요소 중 텍스트가 짧은 것(카드 제목/카드 자체)을 모두 모은다.
    const matches = queryAll('*')
      .filter(element => {
        if (['SCRIPT', 'STYLE', 'HTML', 'BODY', 'HEAD', 'TITLE', 'META', 'LINK'].includes(element.tagName)) return false;
        if (!isVisible(element)) return false;
        const text = normalize(element.textContent);
        return text && text.length <= 200 && youtubeWords.some(word => text.includes(word));
      })
      .sort((a, b) => normalize(a.textContent).length - normalize(b.textContent).length);

    if (!matches.length) {
      return {found: false, success: false, ...diagnostic(), listReason: 'youtube 텍스트 요소 없음'};
    }

    // 가장 가까운 클릭 가능한 조상(a/button/role/pointer)을 카드로 선택, 없으면 텍스트 요소 자체
    const leaf = matches[0];
    const isClickable = element => element.matches('a, button, [role="button"], [role="link"], [tabindex]') ||
      getComputedStyle(element).cursor === 'pointer' || typeof element.onclick === 'function';
    let card = leaf;
    // Apple 구독 목록의 실제 카드: <camk-card data-test="subscription-list-group-card">
    const knownCards = queryAll('[data-test="subscription-list-group-card"], camk-card')
      .filter(element => isVisible(element) && youtubeWords.some(word => normalize(element.textContent).includes(word)))
      .sort((a, b) => normalize(a.textContent).length - normalize(b.textContent).length);
    if (knownCards.length) {
      card = knownCards[0];
    } else {
      for (let el = leaf, depth = 0; el && depth < 8; el = el.parentElement, depth++) {
        if (isClickable(el)) { card = el; if (el.matches('a, button, [role="button"], [role="link"]')) break; }
      }
    }

    if (shouldClick) {
      card.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'});
      const rect = card.getBoundingClientRect();
      const init = {bubbles: true, cancelable: true, composed: true, view: window,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2};
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
        const EventClass = type.startsWith('pointer') ? PointerEvent : MouseEvent;
        card.dispatchEvent(new EventClass(type, init));
      });
    }
    return {found: true, success: true, text: normalize(card.textContent), tag: card.tagName, ...diagnostic()};
  }

  if (action === 'clickConfirm') {
    const button = findButton([
      'button[data-test="button-confirm"]',
      '[data-test="button-confirm"] button',
      'button[data-test="confirm-button"]',
      'button[aria-label*="Confirm" i]'
    ], ['confirm', '확인']);
    if (!button) return {found: false, success: false, ...diagnostic()};
    click(button);
    return {found: true, success: true, text: buttonText(button), ...diagnostic()};
  }

  if (action === 'checkError') {
    const errorPhrases = ['unable to complete purchase', 'unable to charge', '구매를 완료할 수 없', '결제할 수 없'];
    const dialogCandidates = queryAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-test*="modal" i]');
    let errorContainer = dialogCandidates.find(element => {
      const text = normalize(element.textContent);
      return isVisible(element) && errorPhrases.some(phrase => text.includes(phrase));
    });

    if (!errorContainer) {
      const textElement = queryAll('h1, h2, h3, p, span, div').find(element => {
        const text = normalize(element.textContent);
        return isVisible(element) && text.length < 1000 && errorPhrases.some(phrase => text.includes(phrase));
      });
      errorContainer = textElement?.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"]') || textElement;
    }

    if (!errorContainer) {
      return {found: true, success: true, hasError: false, canClick: false};
    }

    const cancelButton = findButton([
      'button[data-test="Cancel-button"]',
      'button[data-test="button-cancel"]',
      '[data-test="Cancel-button"] button',
      'button[aria-label*="Cancel" i]'
    ], ['cancel', '취소'], errorContainer) || findButton([
      'button[data-test="Cancel-button"]',
      'button[data-test="button-cancel"]'
    ], ['cancel', '취소']);

    if (!cancelButton) {
      return {
        found: true,
        success: false,
        hasError: true,
        canClick: false,
        error: '결제 오류는 발견했지만 Cancel 버튼을 찾을 수 없습니다.'
      };
    }

    click(cancelButton);
    return {found: true, success: true, hasError: true, canClick: true, text: buttonText(cancelButton)};
  }

  return {found: false, success: false, error: `지원하지 않는 동작: ${action}`};
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function addLog(message, type = 'info') {
  const entry = {
    time: new Date().toLocaleTimeString('ko-KR'),
    message,
    type,
    timestamp: Date.now()
  };

  const consoleMethod = type === 'error'
    ? console.error
    : type === 'warning'
      ? console.warn
      : console.log;
  consoleMethod.call(console, `[Apple Renew][${entry.time}][${type}] ${message}`);

  logEntries.push(entry);
  saveLogs();

  chrome.runtime.sendMessage({action: 'updateLog', message, type}).catch(() => {});
}

function notifyPopup(status, type, running) {
  chrome.runtime.sendMessage({action: 'updateStatus', status, type, isRunning: running}).catch(() => {});
}

function saveLogs() {
  chrome.storage.local.set({macroLogs: logEntries});
}
