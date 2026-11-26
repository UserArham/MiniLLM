import {
 CreateMLCEngine,
 prebuiltAppConfig
} from "https://esm.run/@mlc-ai/web-llm";

/* MODEL LIST */

const MODELS = {
 "Qwen3-8B-q4f32_1-MLC": {
  name:"Qwen3 8B",
  quant:"Q4F32_1"
 },
 "Qwen3-4B-q4f32_1-MLC": {
  name:"Qwen3 4B",
  quant:"Q4F32_1"
 },
 "Qwen3-1.7B-q4f32_1-MLC": {
  name:"Qwen3 1.7B",
  quant:"Q4F32_1"
 },
 "gemma-2-9b-it-q4f16_1-MLC": {
  name:"Gemma 2 9B",
  quant:"Q4F16_1"
 },
 "gemma-2-2b-it-q4f32_1-MLC-1k": {
  name:"Gemma 2 2B",
  quant:"Q4F32_1",
  context:1024
 },
 "Llama-3.2-3B-Instruct-q4f32_1-MLC": {
  name:"Llama 3.2 3B",
  quant:"Q4F32_1"
 },
 "Llama-3.2-1B-Instruct-q4f32_1-MLC": {
  name:"Llama 3.2 1B",
  quant:"Q4F32_1"
 },
 "stablelm-2-zephyr-1_6b-q4f16_1-MLC": {
  name:"StableLM 2 Zephyr 1.6B",
  quant:"Q4F16_1"
 },
 "SmolLM2-360M-Instruct-q0f32-MLC": {
  name:"SmolLM2 360M Instruct",
  quant:"Q0F32"
 }
};

let engine = null;
let loadedModel = null;
let busy = false;
let conversations = [];
let currentConversation = null;

const $ = id => document.getElementById(id);

/* MARKDOWN */

marked.setOptions({
 gfm:true,
 breaks:true,
 headerIds:false,
 mangle:false
});

function renderMarkdown(source) {
 const html = marked.parse(source || "");
 return DOMPurify.sanitize(html,{
  USE_PROFILES:{html:true}
 });
}

function enhanceMarkdown(container) {
 container.querySelectorAll("pre").forEach(pre => {
  if (pre.parentElement.classList.contains("code-wrapper")) return;

  const code = pre.querySelector("code");
  const wrapper = document.createElement("div");
  wrapper.className = "code-wrapper";

  const header = document.createElement("div");
  header.className = "code-header";

  const match = code?.className.match(/language-([\w-]+)/);
  const label = document.createElement("span");
  label.textContent = match ? match[1] : "Code";

  const copy = document.createElement("button");
  copy.className = "code-copy";
  copy.textContent = "Copy code";

  copy.onclick = async () => {
   try {
    await navigator.clipboard.writeText(code?.textContent || "");
    copy.textContent = "Copied!";
    setTimeout(() => copy.textContent = "Copy code",1300);
   } catch {
    copy.textContent = "Copy unavailable";
   }
  };

  header.append(label,copy);
  pre.replaceWith(wrapper);
  wrapper.append(header,pre);

  if (code && window.hljs) {
   try {window.hljs.highlightElement(code)} catch {}
  }
 });

 container.querySelectorAll("a[href]").forEach(link => {
  const url = new URL(link.href,location.href);
  if (url.protocol === "https:" || url.protocol === "http:") {
   link.target = "_blank";
   link.rel = "noopener noreferrer";
  } else {
   link.removeAttribute("href");
  }
 });
}

/* STORAGE */

function saveData() {
 try {
  localStorage.setItem("minillm31-chats",JSON.stringify(conversations));
 } catch(error) {
  console.warn("Storage unavailable",error);
 }
}

function loadData() {
 try {
  const data = JSON.parse(localStorage.getItem("minillm31-chats") || "[]");
  conversations = Array.isArray(data) ? data : [];
 } catch {
  conversations = [];
 }
}

/* STATUS */

function setStatus(message,ready=false) {
 $("modelStatus").textContent = message;
 $("dot").style.background = ready ? "var(--accent)" : "#888";
 $("dot").style.boxShadow = ready ? "0 0 10px var(--accent)" : "none";
}

/* MODEL SELECTION */

function selectedModel() {
 return document.querySelector('input[name="model"]:checked')?.value;
}

function updateCards() {
 document.querySelectorAll(".model-card").forEach(card => {
  card.classList.toggle(
   "selected",
   card.querySelector("input").checked
  );
 });
}

function openModels() {
 $("modelOverlay").classList.add("show");
}

function closeModels() {
 $("modelOverlay").classList.remove("show");
}

/* GPU RECOVERY */

function isDeviceLost(error) {
 return /device lost|device was lost|GPUDeviceLostInfo/i.test(
  String(error?.message || error)
 );
}

function recoverGPU() {
 engine = null;
 loadedModel = null;
 $("send").disabled = true;
 $("composerModel").textContent = "GPU disconnected";
 setStatus("GPU lost · Reload required");

 const notice = document.createElement("div");
 notice.style.cssText =
  "padding:15px;background:var(--panel);border:1px solid var(--border);border-radius:12px;margin-top:12px";

 const message = document.createElement("p");
 message.textContent =
  "WebGPU was disconnected. Reload MiniLLM to initialize a fresh GPU device.";

 const button = document.createElement("button");
 button.className = "modal-primary";
 button.textContent = "Reload MiniLLM";
 button.onclick = () => location.reload();

 notice.append(message,button);
 $("chatInner").appendChild(notice);
}

/* LOAD MODEL */

async function loadModel() {
 if (busy) return;

 if (!navigator.gpu) {
  setStatus("WebGPU unavailable");
  return;
 }

 const id = selectedModel();
 if (!MODELS[id]) return;

 const registered = prebuiltAppConfig.model_list.some(
  model => model.model_id === id
 );

 if (!registered) {
  setStatus("Model ID not in this WebLLM registry");
  alert(
   "This model ID is not registered in the current WebLLM version:\n\n" + id
  );
  return;
 }

 busy = true;
 $("loadModel").disabled = true;
 $("send").disabled = true;

 try {
  setStatus("Preparing model...");

  if (engine) {
   const oldEngine = engine;
   engine = null;
   loadedModel = null;
   try {await oldEngine.unload()} catch(error) {
    console.warn("Previous engine cleanup failed",error);
   }
  }

  const newEngine = await CreateMLCEngine(id,{
   initProgressCallback: progress => {
    setStatus(progress.text || "Loading model...");
   }
  });

  engine = newEngine;
  loadedModel = id;
  $("composerModel").textContent = MODELS[id].name;
  setStatus(MODELS[id].name + " ready",true);
  closeModels();

 } catch(error) {
  engine = null;
  loadedModel = null;
  setStatus(isDeviceLost(error) ? "GPU device lost" : "Model loading failed");
  alert("Model loading failed:\n" + error.message);
 } finally {
  busy = false;
  $("loadModel").disabled = false;
  $("send").disabled = !engine;
 }
}

/* CHAT UI */

function showWelcome() {
 $("chatInner").innerHTML = `
 <div class="welcome" id="welcome">
  <div class="welcome-icon">✦</div>
  <h1>Welcome to <span class="gradient">MiniLLM.</span></h1>
  <p>Your AI. Your models. Your browser.</p>
  <div class="suggestions">
   <button class="suggestion" data-prompt="Explain how artificial intelligence works.">
    <strong>✧ Learn something</strong><small>Explore a new topic</small>
   </button>
   <button class="suggestion" data-prompt="Write a JavaScript calculator.">
    <strong>⌘ Write some code</strong><small>Build something useful</small>
   </button>
   <button class="suggestion" data-prompt="Give me five creative project ideas.">
    <strong>✦ Get creative</strong><small>Find new inspiration</small>
   </button>
   <button class="suggestion" data-prompt="Explain how computer processors work.">
    <strong>◈ Technology</strong><small>Explore hardware</small>
   </button>
  </div>
 </div>`;
}

function addMessage(role,content,scroll=true) {
 $("welcome")?.remove();

 const row = document.createElement("div");
 row.className = "message-row";
 if (role === "user") row.classList.add("user-row");

 const avatar = document.createElement("div");
 avatar.className = "avatar";
 avatar.textContent = role === "user" ? "◉" : "✦";

 const box = document.createElement("div");
 box.className = "message-content";

 const name = document.createElement("div");
 name.className = "message-name";
 name.textContent = role === "user" ? "You" : "MiniLLM";

 const contentBox = document.createElement("div");
 contentBox.className = "message-text";

 if (role === "assistant") {
  contentBox.classList.add("markdown-body");
  contentBox.innerHTML = renderMarkdown(content);
  enhanceMarkdown(contentBox);
 } else {
  contentBox.textContent = content;
 }

 box.append(name,contentBox);

 if (role === "assistant") {
  const actions = document.createElement("div");
  actions.className = "message-actions";
  const copy = document.createElement("button");
  copy.textContent = "▣ Copy response";
  copy.onclick = async () => {
   try {
    await navigator.clipboard.writeText(contentBox.innerText);
    copy.textContent = "✓ Copied";
   } catch {
    copy.textContent = "Copy unavailable";
   }
  };
  actions.append(copy);
  box.append(actions);
 }

 row.append(avatar,box);
 $("chatInner").appendChild(row);

 if (scroll) $("chatArea").scrollTop = $("chatArea").scrollHeight;
 return contentBox;
}

function updateAssistant(element,text) {
 element.innerHTML = renderMarkdown(text);
 enhanceMarkdown(element);
 $("chatArea").scrollTop = $("chatArea").scrollHeight;
}

/* CONVERSATIONS */

function getConversation() {
 return conversations.find(c => c.id === currentConversation);
}

function newConversation() {
 const conversation = {
  id:crypto.randomUUID(),
  title:"New conversation",
  messages:[],
  model:loadedModel
 };
 conversations.push(conversation);
 currentConversation = conversation.id;
 saveData();
 renderHistory();
 showWelcome();
}

function renderHistory() {
 $("historyList").innerHTML = "";

 [...conversations].reverse().forEach(conversation => {
  const item = document.createElement("div");
  item.className = "history-item";
  if (conversation.id === currentConversation) item.classList.add("selected");

  const title = document.createElement("span");
  title.className = "history-title";
  title.textContent = conversation.title;

  const remove = document.createElement("button");
  remove.className = "history-delete";
  remove.textContent = "×";
  remove.title = "Delete conversation";

  remove.onclick = event => {
   event.stopPropagation();
   conversations = conversations.filter(c => c.id !== conversation.id);
   if (currentConversation === conversation.id) {
    currentConversation = null;
    showWelcome();
   }
   saveData();
   renderHistory();
  };

  item.append(title,remove);
  item.onclick = () => openConversation(conversation.id);
  $("historyList").appendChild(item);
 });
}

function openConversation(id) {
 if (busy) return;
 const conversation = conversations.find(c => c.id === id);
 if (!conversation) return;

 currentConversation = id;
 $("chatInner").innerHTML = "";
 conversation.messages.forEach(message => {
  addMessage(message.role,message.content,false);
 });
 renderHistory();
 $("chatArea").scrollTop = $("chatArea").scrollHeight;
}

function renameConversation(text) {
 const conversation = getConversation();
 if (!conversation || conversation.messages.length) return;
 conversation.title = text.length > 38 ? text.slice(0,38) + "…" : text;
 renderHistory();
}

/* GENERATION */

async function sendMessage() {
 const input = $("prompt").value.trim();
 if (!input || busy) return;

 if (!engine) {
  setStatus("Load a model first");
  openModels();
  return;
 }

 if (!currentConversation) newConversation();

 const conversation = getConversation();
 if (!conversation) return;

 busy = true;
 $("send").disabled = true;
 $("prompt").value = "";
 $("prompt").style.height = "auto";

 renameConversation(input);

 conversation.messages.push({role:"user",content:input});
 addMessage("user",input);

 const output = addMessage("assistant","");
 const thinking = document.createElement("div");
 thinking.className = "thinking";

 for (let i=0;i<3;i++) {
  thinking.appendChild(document.createElement("span"));
 }
 output.appendChild(thinking);

 saveData();

 try {
  const stream = await engine.chat.completions.create({
   messages:[
    {
     role:"system",
     content:
      "You are MiniLLM, a helpful AI assistant. " +
      "Use Markdown when appropriate. Use fenced code blocks for code. " +
      "Be clear, accurate, and helpful."
    },
    ...conversation.messages.slice(-8)
   ],
   temperature:0.7,
   max_tokens:512,
   stream:true
  });

  let answer = "";
  thinking.remove();

  for await (const chunk of stream) {
   answer += chunk.choices[0]?.delta?.content || "";
   updateAssistant(output,answer);
  }

  conversation.messages.push({
   role:"assistant",
   content:answer
  });

  conversation.model = loadedModel;
  saveData();
  renderHistory();
  setStatus(MODELS[loadedModel].name + " ready",true);

 } catch(error) {
  thinking.remove();

  if (isDeviceLost(error)) {
   output.textContent = "WebGPU device lost. Reload MiniLLM to recover.";
   recoverGPU();
  } else {
   output.textContent = "Generation error: " + error.message;
   conversation.messages.pop();
   setStatus("Generation failed");
  }
  saveData();

 } finally {
  busy = false;
  $("send").disabled = !engine;
  $("prompt").focus();
 }
}

/* EVENTS */

$("newChat").onclick = () => {
 if (busy) return;
 currentConversation = null;
 newConversation();
};

$("openModels").onclick = openModels;
$("topModels").onclick = openModels;
$("closeModels").onclick = closeModels;
$("loadModel").onclick = loadModel;
$("modelCards").onchange = updateCards;

$("modelOverlay").onclick = event => {
 if (event.target === $("modelOverlay")) closeModels();
};

$("send").onclick = sendMessage;

$("prompt").oninput = () => {
 const field = $("prompt");
 field.style.height = "auto";
 field.style.height = Math.min(field.scrollHeight,180) + "px";
};

$("prompt").onkeydown = event => {
 if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
  event.preventDefault();
  sendMessage();
 }
};

$("chatInner").onclick = event => {
 const suggestion = event.target.closest("[data-prompt]");
 if (!suggestion) return;
 $("prompt").value = suggestion.dataset.prompt;
 $("prompt").focus();
};

function toggleTheme() {
 document.body.classList.toggle("light");
 try {
  localStorage.setItem(
   "minillm31-theme",
   document.body.classList.contains("light") ? "light" : "dark"
  );
 } catch {}
}

$("theme").onclick = toggleTheme;
$("topTheme").onclick = toggleTheme;

$("collapse").onclick = () => {
 $("sidebar").classList.toggle("collapsed");
};

$("mobileMenu").onclick = () => {
 $("sidebar").classList.toggle("mobile-open");
};

/* STARTUP */

loadData();
renderHistory();
updateCards();

try {
 if (localStorage.getItem("minillm31-theme") === "light") {
  document.body.classList.add("light");
 }
} catch {}
