# accumulating-context
---

```mermaid
graph LR;
user-input-1>user-input-1] -- text:question --> prompt-template-1
prompt-template-1 -- prompt:text --> text-completion-1
text-completion-1 -- completion:text --> console-output-1
console-output-1 -- text:text --> accumulating-context-1
accumulating-context-1 --> user-input-1
accumulating-context-1 -- context:context --> prompt-template-1
```