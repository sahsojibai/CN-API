(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.ChattrnSetup=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 var steps=[{title:'Connect',next:'Continue: review',hint:'Address and authentication'},{title:'Review',next:'Continue: test connection',hint:'Mappings and capabilities'},{title:'Test connection',next:'Connect',hint:'Read-only connection checks'}];
 function unlocked(progress){return progress.reviewed?3:progress.connected?2:1;}
 function allowed(step,progress){return Number.isInteger(step)&&step>=1&&step<=unlocked(progress);}
 function render(buttons,current,progress){Array.from(buttons).forEach(function(button,index){var n=index+1;button.querySelector('.t').textContent=steps[index].title;button.querySelector('.s').textContent=n<current?'Completed':n===current?'You are here':steps[index].hint;button.querySelector('.num').textContent=n<current?'✓':String(n);button.classList.toggle('on',n===current);button.classList.toggle('done',n<current);button.disabled=!allowed(n,progress);if(n===current)button.setAttribute('aria-current','step');else button.removeAttribute('aria-current');});}
 return {steps:steps,unlocked:unlocked,allowed:allowed,render:render};
});
