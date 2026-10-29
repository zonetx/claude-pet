# Claude Pet

Плавающий питомец для Claude Code на Windows (десктоп-приложение Claude).

- Появляется сам при старте любой сессии.
- Прячется, когда окно Claude активно, и выходит, когда Claude свёрнут или закрыт в трей.
- Уходит с анимацией, когда Claude полностью закрыт.
- Показывает, что делает Claude (думает, работает, ждёт, готово), реагирует на поглаживание.
- Запросы разрешений можно одобрить прямо на питомце, пока вы не в Claude.
- Двойной клик — открыть Claude.
- 8 скинов и `/hatch` — вылупить своего питомца.

## Установка

В Claude Code (десктоп или терминал):

```
/plugin marketplace add zonetx/claude-pet
/plugin install pixel-pet@pixel-pet-local
```

Или из терминала:

```
claude plugin marketplace add zonetx/claude-pet
claude plugin install pixel-pet@pixel-pet-local
```

Затем начните новую сессию — питомец появится сам.

## Команды

| Команда | Что делает |
| --- | --- |
| `/pet` | показать или спрятать питомца |
| `/pet show`, `/pet hide` | показать, спрятать |
| `/pet skin <имя>` | сменить скин: claude, cat, robot, ghost, frog, bunny, bear, dragon |
| `/pet name <имя>` | переименовать |
| `/pet ask on\|off` | спрашивать разрешения на питомце или только в Claude |
| `/hatch` | вылупить нового питомца |

## Удаление

```
/plugin uninstall pixel-pet
```

## Требования

Windows 10/11, Windows PowerShell 5.1 (есть в системе).
