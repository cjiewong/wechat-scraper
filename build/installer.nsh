!macro customInit
  ; Try to close old app process before install starts.
  ; Ignore failures (for example process not running).
  nsExec::ExecToLog 'taskkill /F /IM "WeChat Scraper Studio.exe" /T'
!macroend
