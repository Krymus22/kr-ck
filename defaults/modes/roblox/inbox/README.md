# Inbox do Modo Roblox

Jogue arquivos aqui e rode `/organize` (ou pressione `O` no Hub).

A IA organizadora vai:
- Detectar o tipo de cada arquivo (.exe = tool, .md = skill, .js = hook, .json = config)
- Mover para a pasta correta (tools/, skills/, hooks/, mcps/, manifests/)
- Criar manifests automaticamente para tools desconhecidas
- Atualizar o config.json do modo

## Exemplos

```
# Copie arquivos para esta pasta:
cp ~/.rokit/bin/rojo.exe .
cp minha-skill.md .
cp meu-hook.js .

# Depois no claude-killer:
/organize
```

## Tipos suportados

| Extensão | Tipo | Destino |
|---|---|---|
| .exe / sem ext | Tool | tools/ + cria manifest |
| .md | Skill | skills/ |
| .js | Hook | hooks/ |
| .json | Manifest/Config | manifests/ ou mcps/ |
| .zip/.tar.gz | Arquivo | Extrai e re-processa |
