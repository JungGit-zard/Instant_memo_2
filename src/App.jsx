import { useState, useEffect, useRef, useCallback } from "react";

/* ───────────────────────── 유틸 ───────────────────────── */
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const pad = (n) => String(n).padStart(2, "0");
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isSameDay = (a, b) => dateKey(a) === dateKey(b);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
/* 한글 등 IME 조합 중 Enter 방어: 조합 확정 키입력을 무시해 중복/글자잘림 등록 방지 */
const isComposingEvent = (e) => e.nativeEvent && (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229);

const C = {
  bg: "#EEF1F6",
  card: "#FFFFFF",
  ink: "#1F2533",
  sub: "#8A93A6",
  accent: "#2F6BFF",
  accentSoft: "#E8EEFF",
  danger: "#E25549",
  line: "#E3E8F0",
  doneText: "#A6AEBF",
};

/* ───────────── Firebase Realtime Database 동기화 (선택) ─────────────
   아래 설정을 채우면 기기 간 실시간 동기화가 켜진다. 비워두면 로컬 전용 모드.
   [설정 방법]
   1) Firebase 콘솔(console.firebase.google.com) → 프로젝트 생성
   2) 빌드 → Realtime Database → 데이터베이스 만들기
   3) 규칙 탭에 아래 입력 (MVP용):
      {"rules":{"rooms":{"$room":{".read":true,".write":true}}}}
   4) 프로젝트 설정 → 웹 앱 추가 → 구성값을 FIREBASE_CONFIG에 붙여넣기
   5) SYNC_ID에 기기들이 공유할 코드를 지정하고, 모든 기기에 같은 값 입력
   ※ 보안 주의: 위 규칙에서는 SYNC_ID를 아는 사람은 누구나 읽고 쓸 수 있다.
     추측 불가능한 긴 무작위 문자열(예: "kim-todo-x9f3k2q8")을 쓰고,
     정식 서비스 전에는 Firebase Auth 기반 규칙으로 교체할 것. */
const FIREBASE_CONFIG = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "",
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL || "",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "",
};
const SYNC_ID = import.meta.env.VITE_FIREBASE_SYNC_ID || ""; // 기기 간 공유용 동기화 코드
const SYNC_ENABLED = false; // storage-shim owns Firebase sync for every key.
const dayPath = (dk) => `rooms/${SYNC_ID}/days/${dk}`;
const metaPath = (name) => `rooms/${SYNC_ID}/meta/${name}`;
const lastPushed = {}; // dateKey → 마지막으로 원격에 쓴 payload (자기 에코 무시용)

let fbPromise = null;
function loadFirebase() {
  if (!SYNC_ENABLED) return Promise.resolve(null);
  if (!fbPromise) {
    const loadScript = (src) =>
      new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = res;
        s.onerror = () => rej(new Error("스크립트 로드 실패: " + src));
        document.head.appendChild(s);
      });
    // SDK를 CDN에서 동적 로드 (compat 빌드 → 전역 window.firebase 사용)
    fbPromise = loadScript("https://cdnjs.cloudflare.com/ajax/libs/firebase/10.14.1/firebase-app-compat.min.js")
      .then(() => loadScript("https://cdnjs.cloudflare.com/ajax/libs/firebase/10.14.1/firebase-database-compat.min.js"))
      .then(() => {
        window.firebase.initializeApp(FIREBASE_CONFIG);
        return window.firebase.database();
      });
  }
  return fbPromise;
}

/* 하루치 목록을 원격에 기록 (노드 단위 최신 우선) */
async function fbPushDay(dk, itemsArr) {
  if (!SYNC_ENABLED) return;
  try {
    const db = await loadFirebase();
    lastPushed[dk] = JSON.stringify(itemsArr);
    await db.ref(dayPath(dk)).set({ items: itemsArr, updatedAt: Date.now() });
  } catch (e) {
    console.error("동기화 쓰기 실패:", e);
  }
}
async function fbGetMeta(name) {
  if (!SYNC_ENABLED) return null;
  try {
    const db = await loadFirebase();
    const snap = await db.ref(metaPath(name)).get();
    return snap.exists() ? snap.val() : null;
  } catch (e) {
    return null;
  }
}
async function fbSetMeta(name, value) {
  if (!SYNC_ENABLED) return;
  try {
    const db = await loadFirebase();
    await db.ref(metaPath(name)).set(value);
  } catch (e) {
    console.error("메타 동기화 실패:", e);
  }
}

/* ───────────────────────── 메인 앱 ───────────────────────── */
export default function DailyTodoApp() {
  const [date, setDate] = useState(() => new Date());
  const [items, setItems] = useState([]); // {id, text, done, createdAt}
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState("all"); // all | active | done
  const [input, setInput] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");
  const [checkingIds, setCheckingIds] = useState([]); // 체크 직후 애니메이션 대기 중
  const [showDone, setShowDone] = useState(true);
  const [toast, setToast] = useState(null); // {label, restore: [{item, index}] | null}
  const [dragId, setDragId] = useState(null);
  const [dragY, setDragY] = useState(0);
  const [showCalendar, setShowCalendar] = useState(false);

  const inputRef = useRef(null);
  const loadedKeyRef = useRef(null);
  const saveChain = useRef(Promise.resolve()); // 저장 순서 보장 큐 (경합 방지)
  const rolloverRunning = useRef(false);
  const toastTimer = useRef(null);
  const checkTimers = useRef({});
  const dragRef = useRef(null);
  const rowRefs = useRef({});
  const scrollRef = useRef(null);

  const [, setDayTick] = useState(0);

  const key = `todos:${dateKey(date)}`;
  const today = new Date();
  const isToday = isSameDay(date, today);

  /* ── 자정 경계 대응 ──
     자정을 넘기거나 백그라운드에 있다 돌아오면 재렌더를 강제해
     "오늘" 판정(isToday)과 이월 로직이 새 날짜 기준으로 다시 평가되게 한다. */
  useEffect(() => {
    const recheck = () => setDayTick((t) => t + 1);
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("focus", recheck);
    const iv = setInterval(recheck, 60000); // 1분마다 날짜 재판정
    return () => {
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("focus", recheck);
      clearInterval(iv);
    };
  }, []);

  /* ── 데이터 로드 (날짜 변경 시) ── */
  useEffect(() => {
    let cancelled = false;
    loadedKeyRef.current = null;
    setLoaded(false);
    setEditingId(null);
    setCheckingIds([]);
    // 체크 대기 중이던 타이머가 다른 날짜의 목록에 발사되지 않도록 전부 정리
    Object.values(checkTimers.current).forEach(clearTimeout);
    checkTimers.current = {};
    (async () => {
      let data = [];
      try {
        const r = await window.storage.get(key);
        if (r && r.value) data = JSON.parse(r.value);
      } catch (e) {
        /* 저장된 데이터 없음 → 빈 목록 */
      }
      if (!cancelled) {
        setItems(Array.isArray(data) ? data : []);
        loadedKeyRef.current = key;
        setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [key]);

  /* ── 데이터 저장 (변경 시 자동, 순차 큐로 경합 방지) ──
     비동기 set이 서로 추월하면 옛 상태(지운 항목 포함)가 마지막에
     기록될 수 있으므로, 반드시 이전 저장 완료 후 다음 저장을 실행한다. */
  useEffect(() => {
    if (!loaded || loadedKeyRef.current !== key) return;
    const k = key;
    const payload = JSON.stringify(items);
    saveChain.current = saveChain.current.then(async () => {
      try {
        await window.storage.set(k, payload);
      } catch (e) {
        console.error("저장 실패:", e);
      }
      // 원격(RTDB)에도 푸시. 방금 원격에서 받아 채택한 내용(lastPushed와 동일)은 재푸시하지 않음
      if (SYNC_ENABLED) {
        const dk = k.slice("todos:".length);
        if (lastPushed[dk] !== payload) {
          await fbPushDay(dk, JSON.parse(payload));
        }
      }
    });
  }, [items, loaded, key]);

  /* ── 원격 변경 실시간 구독 (RTDB) ──
     현재 보고 있는 날짜의 노드를 구독하고, 다른 기기의 변경이 도착하면 채택한다.
     자기 자신이 쓴 변경의 에코는 lastPushed 비교로 무시해 무한 루프를 방지. */
  useEffect(() => {
    if (!SYNC_ENABLED || !loaded) return;
    const dk = key.slice("todos:".length);
    let unsub = null;
    let disposed = false;
    loadFirebase()
      .then((db) => {
        if (!db || disposed) return;
        const ref = db.ref(dayPath(dk));
        const handler = ref.on("value", (snap) => {
          const remote = snap.val();
          if (!remote || !Array.isArray(remote.items)) return;
          const payload = JSON.stringify(remote.items);
          if (payload === lastPushed[dk]) return; // 자기 에코 무시
          lastPushed[dk] = payload; // 채택 후 save effect가 되밀지 않도록 표시
          setItems(remote.items);
        });
        unsub = () => ref.off("value", handler);
      })
      .catch((e) => console.error("Firebase 연결 실패:", e));
    return () => {
      disposed = true;
      unsub && unsub();
    };
  }, [loaded, key]);

  /* ── 미완료 항목 자동 이월 ──
     오늘 화면을 열면 마지막 이월일(meta) 이후의 날짜들을 순회하며
     미완료 항목을 오늘로 "이동"시킨다 (원본 날짜에서는 제거).
     원본에서 제거하므로 같은 항목이 두 번 살아나는 부활 버그가 없고,
     체크하지 않는 한 매일 계속 따라온다 (영구 이월). */
  useEffect(() => {
    if (!loaded || !isToday || rolloverRunning.current) return;
    rolloverRunning.current = true;
    (async () => {
      try {
        const todayK = dateKey(today);
        let last = null;
        try {
          const r = await window.storage.get("meta:lastRollover");
          last = r && r.value ? r.value : null;
        } catch (e) { /* 첫 실행 */ }
        // 동기화 사용 시: 원격 이월 기록과 비교해 더 최근 값 사용 (다른 기기가 이미
        // 이월했다면 중복 이월을 건너뜀. YYYY-MM-DD는 문자열 비교 = 시간순 비교)
        const remoteLast = await fbGetMeta("lastRollover");
        if (remoteLast && (!last || remoteLast > last)) last = remoteLast;
        if (last === todayK) return;

        // 시작일: 마지막 이월일부터 재스캔(그날 늦게 추가된 항목 포함). 기록이 없으면 최대 366일 전부터.
        // 주의: new Date("YYYY-MM-DD")는 UTC 자정으로 해석돼 시간대에 따라 하루 어긋남 → 로컬 파싱
        const start = last
          ? (() => { const [yy, mm, dd] = last.split("-").map(Number); return new Date(yy, mm - 1, dd); })()
          : (() => { const d = new Date(today); d.setDate(d.getDate() - 366); return d; })();
        const moved = [];
        const d = new Date(start);
        let guard = 0;
        let skippedViewing = false;
        while (dateKey(d) !== todayK && guard < 400) {
          guard++;
          const k = `todos:${dateKey(d)}`;
          // 사용자가 지금 보고 있는 날짜는 건드리지 않는다 (화면 상태와 저장소가 어긋나
          // 지운 항목 부활/중복이 생길 수 있음). 다음 이월 때 처리되도록 남겨둔다.
          if (loadedKeyRef.current === k) { skippedViewing = true; d.setDate(d.getDate() + 1); continue; }
          try {
            const r = await window.storage.get(k);
            if (r && r.value) {
              const arr = JSON.parse(r.value);
              const incomplete = arr.filter((t) => !t.done);
              if (incomplete.length > 0) {
                moved.push(
                  ...incomplete.map((t) => ({ ...t, carried: true, origin: t.origin || dateKey(d) }))
                );
                // 원본 날짜에는 완료 항목만 남긴다 → 부활 원천 차단 (원격에도 동일 반영)
                const remaining = arr.filter((t) => t.done);
                await window.storage.set(k, JSON.stringify(remaining));
                await fbPushDay(dateKey(d), remaining);
              }
            }
          } catch (e) { /* 해당 날짜 데이터 없음 */ }
          d.setDate(d.getDate() + 1);
        }

        if (moved.length > 0) {
          const todayStoreKey = `todos:${todayK}`;
          if (loadedKeyRef.current === todayStoreKey) {
            // 화면이 여전히 "오늘"일 때만 상태로 반영 (저장은 save effect가 수행)
            setItems((prev) => {
              const ids = new Set(prev.map((t) => t.id));
              const add = moved.filter((t) => !ids.has(t.id)); // id 중복 방어
              return [...add, ...prev];
            });
          } else {
            // 스캔 도중 다른 날짜로 이동했다면, 엉뚱한 날짜의 상태를 오염시키지 말고
            // 오늘 저장소에 직접 병합 기록한다 (saveChain 경유로 저장 순서 보장)
            await new Promise((resolve) => {
              saveChain.current = saveChain.current.then(async () => {
                try {
                  let cur = [];
                  try {
                    const r = await window.storage.get(todayStoreKey);
                    if (r && r.value) cur = JSON.parse(r.value);
                  } catch (e2) { /* 오늘 데이터 없음 */ }
                  const ids = new Set(cur.map((t) => t.id));
                  const merged = [...moved.filter((t) => !ids.has(t.id)), ...cur];
                  await window.storage.set(todayStoreKey, JSON.stringify(merged));
                  await fbPushDay(todayK, merged);
                } catch (e2) {
                  console.error("이월 병합 저장 실패:", e2);
                } finally {
                  resolve();
                }
              });
            });
          }
          showToast(`미완료 ${moved.length}개를 오늘로 가져왔어요`, null);
        }
        // 보고 있던 날짜를 건너뛰었다면 이월 완료로 기록하지 않는다 (다음에 재시도)
        if (!skippedViewing) {
          await window.storage.set("meta:lastRollover", todayK);
          await fbSetMeta("lastRollover", todayK);
        }
      } catch (e) {
        console.error("이월 처리 실패:", e);
      } finally {
        rolloverRunning.current = false;
      }
    })();
  }, [loaded, isToday]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── 토스트 (5초 후 자동 닫힘) ── */
  const showToast = useCallback((label, restore) => {
    clearTimeout(toastTimer.current);
    setToast({ label, restore });
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  const undoToast = () => {
    if (!toast || !toast.restore) return;
    setItems((prev) => {
      const next = [...prev];
      [...toast.restore]
        .sort((a, b) => a.index - b.index)
        .forEach(({ item, index }) => {
          if (next.some((t) => t.id === item.id)) return; // 이미 존재하면 중복 복원 방지
          next.splice(Math.min(index, next.length), 0, item);
        });
      return next;
    });
    clearTimeout(toastTimer.current);
    setToast(null);
  };

  /* ── 추가 (빈 입력 방지, 추가 후 포커스 유지) ── */
  const addItem = () => {
    const text = input.trim();
    if (!text) return;
    setItems((prev) => [...prev, { id: uid(), text, done: false, createdAt: Date.now() }]);
    setInput("");
    inputRef.current && inputRef.current.focus();
  };

  /* ── 체크/해제 (체크 시 잠깐 머무른 뒤 완료 섹션으로 이동) ── */
  const toggleItem = (id) => {
    const item = items.find((t) => t.id === id);
    if (!item) return;
    if (item.done) {
      setItems((prev) => prev.map((t) => (t.id === id ? { ...t, done: false } : t)));
      return;
    }
    if (checkingIds.includes(id)) {
      // 이동 대기 중 다시 누르면 취소
      clearTimeout(checkTimers.current[id]);
      setCheckingIds((prev) => prev.filter((x) => x !== id));
      return;
    }
    setCheckingIds((prev) => [...prev, id]);
    checkTimers.current[id] = setTimeout(() => {
      setItems((prev) => prev.map((t) => (t.id === id ? { ...t, done: true } : t)));
      setCheckingIds((prev) => prev.filter((x) => x !== id));
    }, 550);
  };

  /* ── 삭제 + 되돌리기 ── */
  const deleteItem = (id) => {
    const index = items.findIndex((t) => t.id === id);
    if (index < 0) return;
    const item = items[index];
    setItems((prev) => prev.filter((t) => t.id !== id));
    showToast(`"${item.text.slice(0, 12)}${item.text.length > 12 ? "…" : ""}" 삭제됨`, [{ item, index }]);
  };

  const clearCompleted = () => {
    const restore = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.done);
    if (restore.length === 0) return;
    setItems((prev) => prev.filter((t) => !t.done));
    showToast(`완료된 ${restore.length}개 항목 삭제됨`, restore);
  };

  /* ── 인라인 수정 (더블클릭) ── */
  const startEdit = (item) => {
    setEditingId(item.id);
    setEditText(item.text);
  };
  const commitEdit = () => {
    const text = editText.trim();
    if (text) setItems((prev) => prev.map((t) => (t.id === editingId ? { ...t, text } : t)));
    setEditingId(null);
  };

  /* ── 날짜 이동 ── */
  const moveDate = (delta) => {
    const d = new Date(date);
    d.setDate(d.getDate() + delta);
    setDate(d);
  };

  /* ── 드래그 앤 드롭 재배치 (진행중 항목, 핸들 홀드 후 이동) ──
     [버그 수정] 기존 "한 칸씩 교환 + 기준점 보정" 방식은 위로 올릴 때
     보정 직후 dy 부호가 양수로 뒤집혀 곧바로 아래 교환이 재발동
     → 올리자마자 도로 내려가는 문제가 있었음.
     → 드래그 시작 시 순서/행 높이 스냅샷을 찍고, 누적 이동량(dy)으로
       목표 인덱스를 직접 계산해 재배치하는 방식으로 변경.
       (상태 갱신 지연·stale closure와 무관하게 항상 결정적으로 동작) */
  const activeItems = items.filter((t) => !t.done);
  const doneItems = items.filter((t) => t.done);

  const onDragStart = (e, id) => {
    if (filter === "done" || editingId) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* 일부 웹뷰에서 미지원 */ }
    const order = items.filter((t) => !t.done).map((t) => t.id);
    const startIndex = order.indexOf(id);
    if (startIndex < 0) return;
    const el = rowRefs.current[id];
    const slotH = (el ? el.offsetHeight : 48) + 8; // 행 높이 + 행 간격(margin 8px)
    dragRef.current = { id, startY: e.clientY, order, startIndex, curIndex: startIndex, slotH };
    setDragId(id);
    setDragY(0);
  };

  const onDragMove = (e) => {
    const st = dragRef.current;
    if (!st) return;
    const dy = e.clientY - st.startY;
    // 누적 이동량으로 목표 인덱스 계산 (위/아래 대칭, 보정 누락 없음)
    let target = st.startIndex + Math.round(dy / st.slotH);
    target = Math.max(0, Math.min(st.order.length - 1, target));
    if (target !== st.curIndex) {
      st.curIndex = target;
      const newOrder = [...st.order];
      newOrder.splice(st.startIndex, 1);
      newOrder.splice(target, 0, st.id);
      setItems((prev) => {
        const map = new Map(prev.map((t) => [t.id, t]));
        // 스냅샷 이후 done으로 바뀐 항목(체크 대기 완료)은 제외해야
        // 진행중·완료 양쪽에 중복 삽입되는 것을 막을 수 있다
        const actives = newOrder.map((oid) => map.get(oid)).filter((t) => t && !t.done);
        const dones = prev.filter((t) => t.done);
        return [...actives, ...dones];
      });
    }
    // 드래그 중인 행이 손가락을 따라오도록, 인덱스 이동분을 빼고 표시
    setDragY(dy - (st.curIndex - st.startIndex) * st.slotH);
  };

  const onDragEnd = () => {
    dragRef.current = null;
    setDragId(null);
    setDragY(0);
  };

  /* ── 드래그 중: 문서 레벨에서 포인터 추적 + 화면 스크롤 강제 차단 ──
     모바일 웹뷰에서는 핸들의 setPointerCapture가 동작하지 않거나
     브라우저가 제스처를 페이지 스크롤로 가로채는 경우가 있다.
     드래그가 시작되면 document에 리스너를 걸어 어디서 움직여도 추적하고,
     touchmove 기본 동작(스크롤)을 passive:false로 막는다. */
  useEffect(() => {
    if (!dragId) return;
    const move = (e) => onDragMove(e);
    const up = () => onDragEnd();
    const blockScroll = (e) => e.preventDefault();
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
    document.addEventListener("touchmove", blockScroll, { passive: false });
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      document.removeEventListener("touchmove", blockScroll);
      document.body.style.overflow = prevOverflow;
    };
  }, [dragId]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── iOS 고무줄(러버밴드) 바운스 JS 차단 ──
     CSS(overscroll-behavior)가 통하지 않는 iOS 웹뷰 대비책.
     컨테이너가 이미 맨 위인데 아래로 당기거나, 맨 아래인데 위로 당기면
     해당 touchmove의 기본 동작을 직접 막아 화면 전체가 끌리는 것을 차단. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let startY = 0;
    const onTouchStart = (e) => { startY = e.touches[0].clientY; };
    const onTouchMove = (e) => {
      if (e.touches.length !== 1) return;
      const dy = e.touches[0].clientY - startY;
      const atTop = el.scrollTop <= 0;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      // 스크롤할 곳이 없는 방향으로 당기는 제스처만 차단 (정상 스크롤은 통과)
      if ((atTop && dy > 0) || (atBottom && dy < 0)) e.preventDefault();
    };
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, []);

  /* ── 파생 값 ── */
  const total = items.length;
  const doneCount = doneItems.length;
  const progress = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  const visibleActive = filter === "done" ? [] : activeItems;
  const visibleDone = filter === "active" ? [] : doneItems;

  /* ───────────────────────── 렌더 ───────────────────────── */
  return (
    <div ref={scrollRef} style={{ position: "fixed", inset: 0, overflowY: "auto", overflowX: "hidden", overscrollBehaviorY: "none", WebkitOverflowScrolling: "touch", background: C.bg, fontFamily: "'Pretendard', -apple-system, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif", color: C.ink, padding: "24px 12px 96px", boxSizing: "border-box" }}>
      <style>{`
        /* iOS 오버스크롤 바운스(화면 전체가 당겨지는 현상) 방지:
           body 스크롤을 완전히 잠그고, 앱 컨테이너 내부에서만 스크롤한다 */
        html, body { height: 100%; margin: 0; overflow: hidden; overscroll-behavior: none; }
        @keyframes slideIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
        @keyframes toastUp { from { opacity: 0; transform: translate(-50%, 12px); } to { opacity: 1; transform: translate(-50%, 0); } }
        .todo-row { animation: slideIn .18s ease; }
        .todo-row:hover .row-actions { opacity: 1; }
        @media (hover: none) { .row-actions { opacity: 1 !important; } }
        button { cursor: pointer; font-family: inherit; }
        input { font-family: inherit; }
        input:focus, button:focus-visible { outline: 2px solid ${C.accent}; outline-offset: 2px; }
      `}</style>

      <div style={{ width: "100%", maxWidth: 480, margin: "0 auto" }}>
        {/* ── 헤더: 날짜 네비게이션 ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          {/* 일력(日曆) 스타일 날짜 블록 — 클릭하면 달력 열림 */}
          <button onClick={() => setShowCalendar(true)} aria-label="달력에서 날짜 선택" title="달력 열기"
            style={{ background: C.card, border: "none", borderRadius: 14, overflow: "hidden", boxShadow: "0 2px 8px rgba(31,37,51,.08)", width: 64, flexShrink: 0, textAlign: "center", padding: 0 }}>
            <div style={{ background: C.accent, color: "#fff", fontSize: 11, fontWeight: 700, padding: "3px 0", letterSpacing: 1 }}>
              {date.getFullYear()}.{date.getMonth() + 1}
            </div>
            <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.2, paddingTop: 4 }}>{date.getDate()}</div>
            <div style={{ fontSize: 11, color: WEEKDAYS[date.getDay()] === "일" ? C.danger : WEEKDAYS[date.getDay()] === "토" ? C.accent : C.sub, paddingBottom: 5, fontWeight: 600 }}>
              {WEEKDAYS[date.getDay()]}요일 ▾
            </div>
          </button>

          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 18, fontWeight: 800 }}>
              {isToday ? "오늘 할 일" : `${date.getMonth() + 1}월 ${date.getDate()}일 할 일`}
            </div>
            <div style={{ fontSize: 13, color: C.sub, marginTop: 2 }}>
              {total === 0 ? "할 일을 추가해보세요" : `${total}개 중 ${doneCount}개 완료 · ${progress}%`}
            </div>
          </div>

          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <NavBtn label="이전 날짜" onClick={() => moveDate(-1)}>‹</NavBtn>
            {!isToday && (
              <button onClick={() => setDate(new Date())} style={{ border: "none", background: C.accentSoft, color: C.accent, fontWeight: 700, fontSize: 12, padding: "7px 10px", borderRadius: 10 }}>
                오늘
              </button>
            )}
            <NavBtn label="다음 날짜" onClick={() => moveDate(1)}>›</NavBtn>
          </div>
        </div>

        {/* ── 진행률 바 ── */}
        <div style={{ height: 6, background: "#DDE3EE", borderRadius: 99, marginBottom: 16, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${progress}%`, background: progress === 100 ? "#2FA572" : C.accent, borderRadius: 99, transition: "width .35s ease, background .35s" }} />
        </div>

        {/* ── 입력 영역 ── */}
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !isComposingEvent(e)) addItem(); }}
            placeholder="할 일을 입력하세요"
            maxLength={200}
            style={{ flex: 1, border: `1.5px solid ${C.line}`, borderRadius: 12, padding: "12px 14px", fontSize: 15, background: C.card }}
          />
          <button onClick={addItem} disabled={!input.trim()} style={{ border: "none", background: input.trim() ? C.accent : "#C5CEE0", color: "#fff", fontWeight: 700, fontSize: 14, padding: "0 18px", borderRadius: 12, transition: "background .2s" }}>
            추가
          </button>
        </div>

        {/* ── 필터 탭 ── */}
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          {[["all", `전체 ${total}`], ["active", `진행중 ${activeItems.length}`], ["done", `완료 ${doneCount}`]].map(([k, label]) => (
            <button key={k} onClick={() => setFilter(k)} style={{ border: "none", borderRadius: 99, padding: "6px 14px", fontSize: 13, fontWeight: 600, background: filter === k ? C.ink : C.card, color: filter === k ? "#fff" : C.sub, boxShadow: filter === k ? "none" : "0 1px 3px rgba(31,37,51,.06)", transition: "all .15s" }}>
              {label}
            </button>
          ))}
        </div>

        {/* ── 진행중 목록 ── */}
        {visibleActive.length === 0 && visibleDone.length === 0 && loaded && (
          <div style={{ textAlign: "center", padding: "48px 0", color: C.sub }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>☀️</div>
            <div style={{ fontSize: 14 }}>{filter === "done" ? "완료한 일이 아직 없어요" : "오늘 할 일을 추가해보세요"}</div>
          </div>
        )}

        <div>
          {visibleActive.map((item) => {
            const isChecking = checkingIds.includes(item.id);
            const isDragging = dragId === item.id;
            return (
              <div
                key={item.id}
                ref={(el) => (rowRefs.current[item.id] = el)}
                className="todo-row"
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  background: C.card, borderRadius: 12, padding: "12px 12px",
                  marginBottom: 8,
                  boxShadow: isDragging ? "0 8px 20px rgba(31,37,51,.18)" : "0 1px 3px rgba(31,37,51,.06)",
                  transform: isDragging ? `translateY(${dragY}px) scale(1.02)` : "none",
                  opacity: isChecking ? 0.55 : 1,
                  position: "relative", zIndex: isDragging ? 10 : 1,
                  transition: isDragging ? "box-shadow .15s" : "opacity .3s, box-shadow .15s",
                  touchAction: "pan-y",
                }}
              >
                {/* 드래그 핸들 — 터치 영역을 행 높이 전체·폭 36px로 확대 */}
                <div
                  onPointerDown={(e) => onDragStart(e, item.id)}
                  aria-label="순서 변경"
                  style={{ color: "#C5CEE0", fontSize: 18, cursor: "grab", touchAction: "none", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none", lineHeight: 1, alignSelf: "stretch", display: "flex", alignItems: "center", justifyContent: "center", minWidth: 36, margin: "-12px 0 -12px -8px" }}
                >⠿</div>

                {/* 체크박스 */}
                <button
                  onClick={() => toggleItem(item.id)}
                  aria-label={isChecking ? "완료 취소" : "완료 표시"}
                  style={{ width: 24, height: 24, borderRadius: 8, border: `2px solid ${isChecking ? C.accent : "#C5CEE0"}`, background: isChecking ? C.accent : "transparent", color: "#fff", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "all .2s", padding: 0 }}
                >{isChecking ? "✓" : ""}</button>

                {/* 텍스트 / 인라인 수정 */}
                {editingId === item.id ? (
                  <input
                    autoFocus
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => { if (e.key === "Enter" && !isComposingEvent(e)) commitEdit(); if (e.key === "Escape") setEditingId(null); }}
                    style={{ flex: 1, border: `1.5px solid ${C.accent}`, borderRadius: 8, padding: "6px 8px", fontSize: 15 }}
                  />
                ) : (
                  <span
                    onDoubleClick={() => startEdit(item)}
                    title="더블클릭으로 수정"
                    style={{ flex: 1, fontSize: 15, lineHeight: 1.45, wordBreak: "break-word", textDecoration: isChecking ? "line-through" : "none", color: isChecking ? C.doneText : C.ink, transition: "color .2s", userSelect: "none" }}
                  >
                    {item.text}
                    {item.carried && (
                      <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: "#B07A1E", background: "#FBEFD8", borderRadius: 6, padding: "2px 6px", verticalAlign: "middle", whiteSpace: "nowrap" }}>
                        {item.origin ? `${item.origin.slice(5).replace("-", "/")}부터` : "이월"}
                      </span>
                    )}
                  </span>
                )}

                {/* 수정/삭제 버튼 */}
                <div className="row-actions" style={{ display: "flex", gap: 2, opacity: 0, transition: "opacity .15s" }}>
                  <IconBtn label="수정" onClick={() => startEdit(item)}>✎</IconBtn>
                  <IconBtn label="삭제" onClick={() => deleteItem(item.id)} color={C.danger}>🗑</IconBtn>
                </div>
              </div>
            );
          })}
        </div>

        {/* ── 완료 섹션 (접기/펼치기 + 일괄 삭제) ── */}
        {visibleDone.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <button onClick={() => setShowDone((v) => !v)} style={{ border: "none", background: "transparent", color: C.sub, fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", gap: 6, padding: 4 }}>
                <span style={{ display: "inline-block", transform: showDone ? "rotate(90deg)" : "none", transition: "transform .15s", fontSize: 11 }}>▶</span>
                완료됨 {visibleDone.length}
              </button>
              <div style={{ flex: 1 }} />
              <button onClick={clearCompleted} style={{ border: "none", background: "transparent", color: C.danger, fontSize: 12, fontWeight: 600, padding: 4 }}>
                완료 항목 모두 삭제
              </button>
            </div>
            {showDone && visibleDone.map((item) => (
              <div key={item.id} className="todo-row" style={{ display: "flex", alignItems: "center", gap: 10, background: "#F6F8FB", borderRadius: 12, padding: "11px 12px", marginBottom: 6 }}>
                <button onClick={() => toggleItem(item.id)} aria-label="완료 해제" style={{ width: 24, height: 24, borderRadius: 8, border: "2px solid transparent", background: "#B9C2D4", color: "#fff", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, padding: 0 }}>✓</button>
                <span style={{ flex: 1, fontSize: 15, textDecoration: "line-through", color: C.doneText, wordBreak: "break-word" }}>{item.text}</span>
                <IconBtn label="삭제" onClick={() => deleteItem(item.id)} color={C.danger}>🗑</IconBtn>
              </div>
            ))}
          </div>
        )}

        {/* ── 사용 안내 ── */}
        {total > 0 && (
          <div style={{ marginTop: 20, fontSize: 12, color: "#AEB6C6", textAlign: "center", lineHeight: 1.7 }}>
            ⠿ 핸들을 잡고 드래그하면 순서가 바뀌고, 항목을 더블클릭하면 수정됩니다.<br />
            체크하면 잠시 후 완료 목록으로 이동합니다.
          </div>
        )}
      </div>

      {/* ── 달력 모달 (년/월/일 직접 지정) ── */}
      {showCalendar && (
        <CalendarModal
          value={date}
          today={today}
          onSelect={(d) => { setDate(d); setShowCalendar(false); }}
          onClose={() => setShowCalendar(false)}
        />
      )}

      {/* ── 되돌리기 토스트 ── */}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: C.ink, color: "#fff", borderRadius: 12, padding: "12px 16px", display: "flex", alignItems: "center", gap: 14, fontSize: 14, boxShadow: "0 8px 24px rgba(31,37,51,.3)", animation: "toastUp .2s ease", maxWidth: "calc(100% - 32px)", zIndex: 100 }}>
          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{toast.label}</span>
          {toast.restore && (
            <button onClick={undoToast} style={{ border: "none", background: "transparent", color: "#7EA2FF", fontWeight: 800, fontSize: 14, padding: 0, flexShrink: 0 }}>되돌리기</button>
          )}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── 달력 모달 ───────────────────────── */
function CalendarModal({ value, today, onSelect, onClose }) {
  const [viewY, setViewY] = useState(value.getFullYear());
  const [viewM, setViewM] = useState(value.getMonth()); // 0-11

  const moveMonth = (delta) => {
    const d = new Date(viewY, viewM + delta, 1);
    setViewY(d.getFullYear());
    setViewM(d.getMonth());
  };

  const startDow = new Date(viewY, viewM, 1).getDay();
  const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
  const cells = [...Array(startDow).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];

  const selKey = dateKey(value);
  const todayKey = dateKey(today);

  return (
    <div onClick={onClose} role="dialog" aria-label="날짜 선택 달력"
      style={{ position: "fixed", inset: 0, background: "rgba(31,37,51,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: "#fff", borderRadius: 18, padding: 18, width: "100%", maxWidth: 340, boxShadow: "0 16px 48px rgba(31,37,51,.25)", animation: "slideIn .18s ease" }}>

        {/* 년도 이동 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <NavBtn label="이전 해" onClick={() => moveMonth(-12)}>«</NavBtn>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#8A93A6" }}>{viewY}년</span>
          <NavBtn label="다음 해" onClick={() => moveMonth(12)}>»</NavBtn>
        </div>

        {/* 월 이동 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <NavBtn label="이전 달" onClick={() => moveMonth(-1)}>‹</NavBtn>
          <span style={{ fontSize: 18, fontWeight: 800 }}>{viewM + 1}월</span>
          <NavBtn label="다음 달" onClick={() => moveMonth(1)}>›</NavBtn>
        </div>

        {/* 요일 헤더 */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", marginBottom: 4 }}>
          {WEEKDAYS.map((w, i) => (
            <div key={w} style={{ textAlign: "center", fontSize: 11, fontWeight: 700, color: i === 0 ? "#E25549" : i === 6 ? "#2F6BFF" : "#8A93A6", padding: "4px 0" }}>{w}</div>
          ))}
        </div>

        {/* 날짜 그리드 */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
          {cells.map((day, i) => {
            if (day === null) return <div key={`b${i}`} />;
            const d = new Date(viewY, viewM, day);
            const k = dateKey(d);
            const isSel = k === selKey;
            const isTd = k === todayKey;
            const dow = d.getDay();
            return (
              <button key={k} onClick={() => onSelect(d)}
                style={{
                  aspectRatio: "1", border: isTd && !isSel ? "1.5px solid #2F6BFF" : "none",
                  borderRadius: 10, fontSize: 14, fontWeight: isSel || isTd ? 800 : 500,
                  background: isSel ? "#2F6BFF" : "transparent",
                  color: isSel ? "#fff" : dow === 0 ? "#E25549" : dow === 6 ? "#2F6BFF" : "#1F2533",
                  display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
                }}>
                {day}
              </button>
            );
          })}
        </div>

        {/* 하단 버튼 */}
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button onClick={() => onSelect(new Date())} style={{ flex: 1, border: "none", background: "#E8EEFF", color: "#2F6BFF", fontWeight: 700, fontSize: 13, padding: "10px 0", borderRadius: 10 }}>오늘로 이동</button>
          <button onClick={onClose} style={{ flex: 1, border: "none", background: "#F1F3F8", color: "#8A93A6", fontWeight: 700, fontSize: 13, padding: "10px 0", borderRadius: 10 }}>닫기</button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── 작은 컴포넌트 ───────────────────────── */
function NavBtn({ children, onClick, label }) {
  return (
    <button onClick={onClick} aria-label={label} style={{ width: 32, height: 32, borderRadius: 10, border: "none", background: "#FFFFFF", color: "#1F2533", fontSize: 18, fontWeight: 700, boxShadow: "0 1px 3px rgba(31,37,51,.08)", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>
      {children}
    </button>
  );
}

function IconBtn({ children, onClick, label, color = "#8A93A6" }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} style={{ width: 30, height: 30, borderRadius: 8, border: "none", background: "transparent", color, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
      {children}
    </button>
  );
}
