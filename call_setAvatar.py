with open(r'C:\patriot-grodno\src\app.js','r',encoding='utf-8',errors='ignore') as f:
    content = f.read()
content = content.replace('initTelegram();', 'initTelegram();\n    setAvatar("img/avatar-user.jpg");')
with open(r'C:\patriot-grodno\src\app.js','w',encoding='utf-8') as f:
    f.write(content)
print('call added')
