with open(r'C:\patriot-grodno\src\app.js','r',encoding='utf-8',errors='ignore') as f:
    content = f.read()
func = '''
  function setAvatar(url) {
    if (!url) return;
    var img = document.createElement("img");
    img.src = url;
    img.alt = "Аватар";
    img.style.cssText = "width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block;";
    img.onerror = function() { this.style.display = "none"; };
    var m = document.getElementById("brandMark");
    if (m) { m.innerHTML = ""; m.style.background = "#1a1814"; m.style.border = "1.5px solid #8a6f3f"; m.appendChild(img.cloneNode()); }
    var p = document.getElementById("avatarImg");
    if (p) { p.innerHTML = ""; p.style.background = "#2a2418"; p.style.border = "2px solid #8a6f3f"; p.appendChild(img); }
  }
'''
content = content.replace('function tg() {', func + 'function tg() {')
with open(r'C:\patriot-grodno\src\app.js','w',encoding='utf-8') as f:
    f.write(content)
print('done')
