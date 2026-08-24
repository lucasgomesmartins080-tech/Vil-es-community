# Vilões Community — instruções do projeto

Site da comunidade Discord "Vilões Community": Express + sessão via Discord OAuth2,
dados persistidos em `data.json`, painel admin restrito por `ADMIN_IDS` no `.env`.
Deploy no Render (free tier, disco efêmero — `data.json` e `public/uploads/`
resetam a cada redeploy), repositório no GitHub em
`lucasgomesmartins080-tech/Vil-es-community`, branch `main`.

## Deploy

- O Render está conectado ao GitHub e redeploya sozinho a cada push na `main`.
- **Pode commitar e dar `git push` direto, sem pedir confirmação antes**, sempre
  que uma alteração de código estiver pronta e testada localmente.
- Continue nunca commitando `.env` nem `data.json` (já estão no `.gitignore`).
