'use strict';

let rules = [];
self.onmessage = ({ data }) => {
  if (Array.isArray(data.rules)) {
    rules = data.rules.map(rule => ({ regex: new RegExp(rule.pattern, 'u'), action: rule.action }));
  } else {
    const hits = [];
    for (const { regex, action } of rules) {
      const result = regex.exec(data.line);
      if (result) hits.push({ action, offset: result.index, length: result[0].length });
    }
    self.postMessage({ sequence: data.sequence, hits });
  }
};
