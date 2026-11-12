(function () {
  var themes = ['light', 'dusk', 'sand', 'mist', 'moss', 'ember'];
  var theme = 'light';
  try {
    var saved = localStorage.getItem('beat.theme');
    if (themes.indexOf(saved) !== -1) theme = saved;
  } catch (e) { }
  document.documentElement.dataset.theme = theme;
})();
