/* Тема «Туман»: ставить data-fog на <html> (за замовчуванням увімкнено) і додає перемикач
   у навбар на сторінках без власної кнопки (admin.html, instruktor-*). Стан спільний
   для всього сайту через localStorage "fd-fog". index.html має власний перемикач. */
(function(){
  var root=document.documentElement;
  function isOn(){try{return localStorage.getItem("fd-fog")!=="off"}catch(e){return true}}
  function apply(on){if(on)root.setAttribute("data-fog","on");else root.removeAttribute("data-fog")}
  apply(isOn());
  document.addEventListener("DOMContentLoaded",function(){
    if(document.getElementById("fog-toggle"))return;
    var host=document.querySelector(".geo-nav .wrap")||document.querySelector("nav.nav");
    if(!host)return;
    var b=document.createElement("button");
    b.id="fog-toggle";b.type="button";b.className="fog-toggle";
    b.title='Тема «Туман»';b.setAttribute("aria-label",'Тема «Туман»');
    b.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 16a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17 9a3.5 3.5 0 0 1 .5 7H7z"/><path d="M5 20h8M15 20h4"/></svg>';
    b.setAttribute("aria-pressed",isOn()?"true":"false");
    b.addEventListener("click",function(){
      var on=root.getAttribute("data-fog")!=="on";apply(on);
      try{localStorage.setItem("fd-fog",on?"on":"off")}catch(e){}
      b.setAttribute("aria-pressed",on?"true":"false");
    });
    var first=host.querySelector("button,.home");
    if(host.classList.contains("wrap")){var home=host.querySelector(".home");if(home){home.style.marginLeft="auto";b.style.marginLeft="12px";host.appendChild(b);return}}
    if(first)host.insertBefore(b,first);else host.appendChild(b);
  });
})();
