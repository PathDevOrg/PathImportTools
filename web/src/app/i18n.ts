import { productCopy } from "./productCopy";

export type LocaleCode =
  | "en"
  | "zh-Hans"
  | "zh-Hant"
  | "ja"
  | "ko"
  | "de"
  | "fr"
  | "es"
  | "pt"
  | "it"
  | "nl"
  | "da"
  | "fi"
  | "sv"
  | "pl"
  | "uk"
  | "id"
  | "th"
  | "vi";

export type LocaleInfo = {
  code: LocaleCode;
  label: string;
  short: string;
};

export const SUPPORTED_LOCALES: LocaleInfo[] = [
  { code: "en", label: "English", short: "EN" },
  { code: "zh-Hans", label: "简体中文", short: "简" },
  { code: "zh-Hant", label: "繁體中文", short: "繁" },
  { code: "ja", label: "日本語", short: "JA" },
  { code: "ko", label: "한국어", short: "KO" },
  { code: "de", label: "Deutsch", short: "DE" },
  { code: "fr", label: "Français", short: "FR" },
  { code: "es", label: "Español", short: "ES" },
  { code: "pt", label: "Português", short: "PT" },
  { code: "it", label: "Italiano", short: "IT" },
  { code: "nl", label: "Nederlands", short: "NL" },
  { code: "da", label: "Dansk", short: "DA" },
  { code: "fi", label: "Suomi", short: "FI" },
  { code: "sv", label: "Svenska", short: "SV" },
  { code: "pl", label: "Polski", short: "PL" },
  { code: "uk", label: "Українська", short: "UK" },
  { code: "id", label: "Bahasa Indonesia", short: "ID" },
  { code: "th", label: "ไทย", short: "TH" },
  { code: "vi", label: "Tiếng Việt", short: "VI" },
];

export type TranslationStrings = Record<keyof typeof productCopy, string> & {
  selectZipLabel: string;
  dropZonePrompt: string;
  statsSummary: string;
  statsDays: string;
  statsStays: string;
  statsMoves: string;
  statsPois: string;
  handoffTitle: string;
  handoffStep1: string;
  handoffStep2: string;
  handoffStep3: string;
};

const enTranslations: TranslationStrings = {
  ...productCopy,
  selectZipLabel: "or select a .zip archive",
  dropZonePrompt: "Drop backup folder or .zip here",
  statsSummary: "Timeline summary",
  statsDays: "days",
  statsStays: "stays",
  statsMoves: "trips",
  statsPois: "places",
  handoffTitle: "How to import into Path on iPhone",
  handoffStep1: "Transfer the .sqlite file to your iPhone via AirDrop or iCloud Drive.",
  handoffStep2: "Open Path on your iPhone, then go to Settings → Data & Storage.",
  handoffStep3: 'Tap "Import from SQLite" and select this file.',
};

const zhHansTranslations: TranslationStrings = {
  appName: "Path Import",
  githubRepoLabel: "在 GitHub 查看源码",
  githubRepoHref: productCopy.githubRepoHref,
  navHomeLabel: "Path Import 首页",
  heroTitle: "在本地转换 Arc 与 Moves 备份",
  heroBody: "选择备份文件夹或 ZIP 压缩包。Path Import 完全在本地生成数据库文件。",
  selectFolderLabel: "选择备份文件夹",
  selectZipLabel: "或选择 .zip 压缩包",
  dropZonePrompt: "将备份文件夹或 .zip 拖拽至此处",
  workingStep: "第 2 步，共 3 步",
  workingTitle: "正在转换数据",
  workingBody: "Path Import 正在解析文件、消除时序重叠并准备数据库。",
  workingFallback: "正在准备文件",
  cancelLabel: "取消转换",
  cancelConfirm: "确定要取消本次转换吗？所有已处理进度将被丢弃。",
  completeStep: "第 3 步，共 3 步",
  completeTitle: "导入文件已准备就绪",
  completeSavedBody: "导入数据库已保存在所选文件夹中。在 iPhone 上打开 Path 并通过【设置】导入。",
  completeDownloadBody: "导入数据库已自动下载。在 iPhone 上打开 Path 并通过【设置】导入。",
  savedStatus: "已保存至磁盘",
  downloadAgainLabel: "再次下载",
  chooseAnotherLabel: "选择其他备份",
  errorTitle: "未能识别该备份内容",
  errorFallback: "请选取包含 Arc Export、Arc Previous Backups 或 Moves 数据的文件夹或 ZIP 压缩包。",
  errorUnknownTitle: "发生错误",
  privacyStatement:
    "Path Import 为纯离线运行设计：您选取的所有文件均在当前设备本地读取与转换，绝不进行任何数据上传。页面加载完成后，您可以断开网络继续使用。",
  statsSummary: "时间线数据概览",
  statsDays: "天",
  statsStays: "次停留",
  statsMoves: "段行程",
  statsPois: "个地点",
  handoffTitle: "如何导入至 iPhone 上的 Path",
  handoffStep1: "通过隔空投送（AirDrop）或存储至 iCloud 云盘将 .sqlite 文件发送至 iPhone。",
  handoffStep2: "在 iPhone 上打开 Path，进入【设置】→【数据与存储】。",
  handoffStep3: "点击【从 SQLite 备份导入】并选取该文件。",
};

const zhHantTranslations: TranslationStrings = {
  appName: "Path Import",
  githubRepoLabel: "在 GitHub 檢視原始碼",
  githubRepoHref: productCopy.githubRepoHref,
  navHomeLabel: "Path Import 首頁",
  heroTitle: "在本地轉換 Arc 與 Moves 備份",
  heroBody: "選取備份資料夾或 ZIP 壓縮檔。Path Import 完全在本地產生資料庫檔案。",
  selectFolderLabel: "選取備份資料夾",
  selectZipLabel: "或選取 .zip 壓縮檔",
  dropZonePrompt: "將備份資料夾或 .zip 拖放至此處",
  workingStep: "第 2 步，共 3 步",
  workingTitle: "正在轉換資料",
  workingBody: "Path Import 正在解析檔案、消除時序重疊並準備資料庫。",
  workingFallback: "正在準備檔案",
  cancelLabel: "取消轉換",
  cancelConfirm: "確定要取消本次轉換嗎？所有已處理進度將被放棄。",
  completeStep: "第 3 步，共 3 步",
  completeTitle: "匯入檔案已準備就緒",
  completeSavedBody: "匯入資料庫已直接儲存在所選資料夾中。在 iPhone 上打開 Path 並透過【設定】匯入。",
  completeDownloadBody: "匯入資料庫已自動下載。在 iPhone 上打開 Path 並透過【設定】匯入。",
  savedStatus: "已儲存至磁碟",
  downloadAgainLabel: "再次下載",
  chooseAnotherLabel: "選取其他備份",
  errorTitle: "未能識別該備份內容",
  errorFallback: "請選取包含 Arc Export、Arc Previous Backups 或 Moves 資料的資料夾或 ZIP 壓縮檔。",
  errorUnknownTitle: "發生錯誤",
  privacyStatement:
    "Path Import 為純離線運作設計：您選取的所有檔案均在目前裝置本機讀取與轉換，絕無任何資料上傳。頁面載入完成後，您可以中斷網路連線繼續使用。",
  statsSummary: "時間軸資料概覽",
  statsDays: "天",
  statsStays: "次停留",
  statsMoves: "段行程",
  statsPois: "個地點",
  handoffTitle: "如何匯入至 iPhone 上的 Path",
  handoffStep1: "透過隔空投送（AirDrop）或儲存至 iCloud 雲碟將 .sqlite 檔案傳送至 iPhone。",
  handoffStep2: "在 iPhone 上開啟 Path，進入【設定】→【資料與儲存空間】。",
  handoffStep3: "點選【從 SQLite 備份匯入】並選取該檔案。",
};

const jaTranslations: TranslationStrings = {
  appName: "Path Import",
  githubRepoLabel: "GitHubでソースコードを見る",
  githubRepoHref: productCopy.githubRepoHref,
  navHomeLabel: "Path Import ホーム",
  heroTitle: "ArcおよびMovesのバックアップを端末内で変換",
  heroBody: "バックアップフォルダまたはZIPを選択してください。Path Importが端末内でデータベースを作成します。",
  selectFolderLabel: "バックアップフォルダを選択",
  selectZipLabel: "または .zip アーカイブを選択",
  dropZonePrompt: "フォルダまたは .zip をここにドロップ",
  workingStep: "ステップ 2 / 3",
  workingTitle: "データを変換中",
  workingBody: "ファイルの読み込み、タイムラインの重複調整、データベースの構築を行っています。",
  workingFallback: "ファイルを準備中",
  cancelLabel: "変換をキャンセル",
  cancelConfirm: "変換をキャンセルしますか？これまでの進捗は破棄されます。",
  completeStep: "ステップ 3 / 3",
  completeTitle: "インポートファイルの準備が完了しました",
  completeSavedBody:
    "変換されたデータベースを選択したフォルダに保存しました。iPhoneのPathの「設定」からインポートしてください。",
  completeDownloadBody:
    "データベースが自動的にダウンロードされました。iPhoneのPathの「設定」からインポートしてください。",
  savedStatus: "ディスクに保存完了",
  downloadAgainLabel: "もう一度ダウンロード",
  chooseAnotherLabel: "別のバックアップを選択",
  errorTitle: "バックアップフォルダを認識できませんでした",
  errorFallback: "Arc Export、Arc Previous Backups、またはMovesデータを含むフォルダかZIPを選択してください。",
  errorUnknownTitle: "エラーが発生しました",
  privacyStatement:
    "Path Importは完全オフラインで動作します。選択したデータはすべてお使いの端末内でのみ読み込み・変換され、サーバーへの送信は一切行われません。",
  statsSummary: "タイムライン概要",
  statsDays: "日",
  statsStays: "箇所の滞在",
  statsMoves: "回の移動",
  statsPois: "箇所のスポット",
  handoffTitle: "iPhoneのPathへインポートする手順",
  handoffStep1: ".sqliteファイルをAirDropまたはiCloud DriveでiPhoneに転送します。",
  handoffStep2: "iPhoneでPathを開き、「設定」→「データとストレージ」へ進みます。",
  handoffStep3: "「SQLiteからインポート」をタップして本ファイルを選択します。",
};

const koTranslations: TranslationStrings = {
  appName: "Path Import",
  githubRepoLabel: "GitHub에서 소스 코드 보기",
  githubRepoHref: productCopy.githubRepoHref,
  navHomeLabel: "Path Import 홈",
  heroTitle: "Arc 및 Moves 백업을 기기 내에서 로컬 변환",
  heroBody: "백업 폴더 또는 ZIP 파일을 선택하세요. Path Import가 기기 내에서 로컬 데이터베이스를 생성합니다.",
  selectFolderLabel: "백업 폴더 선택",
  selectZipLabel: "또는 .zip 파일 선택",
  dropZonePrompt: "백업 폴더 또는 .zip을 여기에 드롭하세요",
  workingStep: "3단계 중 2단계",
  workingTitle: "데이터 변환 중",
  workingBody: "Path Import가 파일을 읽고, 겹치는 타임라인을 정리하여 데이터베이스를 준비 중입니다.",
  workingFallback: "파일 준비 중",
  cancelLabel: "변환 취소",
  cancelConfirm: "변환을 취소하시겠습니까? 진행 상황이 삭제됩니다.",
  completeStep: "3단계 중 3단계",
  completeTitle: "가져오기 파일 준비 완료",
  completeSavedBody: "변환된 데이터베이스가 선택한 폴더에 저장되었습니다. iPhone의 Path 앱 설정에서 가져오세요.",
  completeDownloadBody: "변환된 데이터베이스가 자동으로 다운로드되었습니다. iPhone의 Path 앱 설정에서 가져오세요.",
  savedStatus: "디스크에 저장됨",
  downloadAgainLabel: "다시 다운로드",
  chooseAnotherLabel: "다른 백업 선택",
  errorTitle: "백업 폴더를 인식할 수 없습니다",
  errorFallback: "Arc Export, Arc Previous Backups 또는 Moves 데이터가 포함된 폴더나 ZIP 파일을 선택하세요.",
  errorUnknownTitle: "오류가 발생했습니다",
  privacyStatement:
    "Path Import는 완벽한 오프라인 작동을 위해 설계되었습니다. 선택한 모든 데이터는 기기 로컬에서만 변환되며 서버로 전송되지 않습니다.",
  statsSummary: "타임라인 요약",
  statsDays: "일",
  statsStays: "회 체류",
  statsMoves: "개 이동",
  statsPois: "개 장소",
  handoffTitle: "iPhone Path 앱으로 가져오는 방법",
  handoffStep1: "AirDrop 또는 iCloud Drive를 통해 .sqlite 파일을 iPhone으로 전송합니다.",
  handoffStep2: "iPhone에서 Path 앱을 열고 [설정] → [데이터 및 저장 공간]으로 이동합니다.",
  handoffStep3: "[SQLite 백업에서 가져오기]를 탭하고 이 파일을 선택합니다.",
};

const deTranslations: TranslationStrings = {
  appName: "Path Import",
  githubRepoLabel: "Quellcode auf GitHub ansehen",
  githubRepoHref: productCopy.githubRepoHref,
  navHomeLabel: "Path Import Startseite",
  heroTitle: "Arc- und Moves-Backups lokal konvertieren",
  heroBody: "Wählen Sie einen Backup-Ordner oder eine ZIP-Datei. Path Import erstellt die Datenbank direkt im Browser.",
  selectFolderLabel: "Backup-Ordner wählen",
  selectZipLabel: "oder .zip-Archiv wählen",
  dropZonePrompt: "Backup-Ordner oder .zip hier ablegen",
  workingStep: "Schritt 2 von 3",
  workingTitle: "Daten werden konvertiert",
  workingBody: "Path Import liest Dateien, löst Überschneidungen auf und bereitet Ihre Datenbank vor.",
  workingFallback: "Dateien werden vorbereitet",
  cancelLabel: "Konvertierung abbrechen",
  cancelConfirm: "Konvertierung wirklich abbrechen? Der bisherige Fortschritt geht verloren.",
  completeStep: "Schritt 3 von 3",
  completeTitle: "Import-Datei bereit",
  completeSavedBody:
    "Ihre Datenbank wurde im ausgewählten Ordner gespeichert. Öffnen Sie Path auf dem iPhone zum Importieren.",
  completeDownloadBody:
    "Ihre Datenbank wurde automatisch heruntergeladen. Öffnen Sie Path auf dem iPhone zum Importieren.",
  savedStatus: "Auf Festplatte gespeichert",
  downloadAgainLabel: "Erneut herunterladen",
  chooseAnotherLabel: "Anderes Backup wählen",
  errorTitle: "Ordner wurde nicht erkannt",
  errorFallback: "Wählen Sie den Ordner oder die ZIP-Datei mit Arc Export, Arc Previous Backups oder Moves-Daten.",
  errorUnknownTitle: "Etwas ist schiefgelaufen",
  privacyStatement:
    "Path Import arbeitet vollständig offline: Alle gewählten Daten werden auf diesem Gerät verarbeitet, ohne Uploads.",
  statsSummary: "Timeline-Übersicht",
  statsDays: "Tage",
  statsStays: "Aufenthalte",
  statsMoves: "Fahrten & Wege",
  statsPois: "Orte",
  handoffTitle: "So importieren Sie in Path auf dem iPhone",
  handoffStep1: "Übertragen Sie die .sqlite-Datei via AirDrop oder iCloud Drive auf Ihr iPhone.",
  handoffStep2: "Öffnen Sie Path auf dem iPhone und gehen Sie zu Einstellungen → Daten & Speicher.",
  handoffStep3: "Tippen Sie auf „Aus SQLite-Backup importieren“ und wählen Sie diese Datei.",
};

const frTranslations: TranslationStrings = {
  appName: "Path Import",
  githubRepoLabel: "Voir le code sur GitHub",
  githubRepoHref: productCopy.githubRepoHref,
  navHomeLabel: "Accueil Path Import",
  heroTitle: "Convertissez vos sauvegardes Arc et Moves localement",
  heroBody: "Sélectionnez un dossier ou un fichier ZIP. Path Import crée votre base de données localement.",
  selectFolderLabel: "Sélectionner un dossier",
  selectZipLabel: "ou sélectionner une archive .zip",
  dropZonePrompt: "Déposez votre dossier ou fichier .zip ici",
  workingStep: "Étape 2 sur 3",
  workingTitle: "Conversion des données",
  workingBody: "Path Import lit vos fichiers, résout les chevauchements et prépare votre base de données.",
  workingFallback: "Préparation des fichiers",
  cancelLabel: "Annuler la conversion",
  cancelConfirm: "Annuler cette conversion ? Toute progression sera perdue.",
  completeStep: "Étape 3 sur 3",
  completeTitle: "Fichier d'import prêt",
  completeSavedBody:
    "Votre base de données a été enregistrée dans le dossier choisi. Ouvrez Path sur iPhone pour l'importer.",
  completeDownloadBody:
    "Votre base de données a été téléchargée automatiquement. Ouvrez Path sur iPhone pour l'importer.",
  savedStatus: "Enregistré sur le disque",
  downloadAgainLabel: "Télécharger à nouveau",
  chooseAnotherLabel: "Choisir une autre sauvegarde",
  errorTitle: "Dossier non reconnu",
  errorFallback: "Choisissez le dossier ou ZIP contenant Arc Export, Arc Previous Backups ou Moves.",
  errorUnknownTitle: "Une erreur est survenue",
  privacyStatement:
    "Path Import fonctionne entièrement hors-ligne : toutes vos données restent sur votre appareil sans aucun transfert réseau.",
  statsSummary: "Résumé de la chronologie",
  statsDays: "jours",
  statsStays: "séjours",
  statsMoves: "trajets",
  statsPois: "lieux",
  handoffTitle: "Comment importer dans Path sur iPhone",
  handoffStep1: "Transférez le fichier .sqlite sur votre iPhone via AirDrop ou iCloud Drive.",
  handoffStep2: "Ouvrez Path sur iPhone, puis allez dans Réglages → Données et stockage.",
  handoffStep3: "Appuyez sur « Importer depuis SQLite » et sélectionnez ce fichier.",
};

const esTranslations: TranslationStrings = {
  appName: "Path Import",
  githubRepoLabel: "Ver código en GitHub",
  githubRepoHref: productCopy.githubRepoHref,
  navHomeLabel: "Inicio Path Import",
  heroTitle: "Convierte copias de seguridad de Arc y Moves localmente",
  heroBody: "Selecciona una carpeta o archivo ZIP. Path Import crea la base de datos localmente.",
  selectFolderLabel: "Seleccionar carpeta de respaldo",
  selectZipLabel: "o seleccionar archivo .zip",
  dropZonePrompt: "Arrastra la carpeta o .zip aquí",
  workingStep: "Paso 2 de 3",
  workingTitle: "Convirtiendo datos",
  workingBody: "Path Import está leyendo los archivos y preparando tu base de datos.",
  workingFallback: "Preparando archivos",
  cancelLabel: "Cancelar conversión",
  cancelConfirm: "¿Deseas cancelar la conversión? El progreso se descartará.",
  completeStep: "Paso 3 de 3",
  completeTitle: "Archivo listo para importar",
  completeSavedBody: "Tu base de datos se guardó en la carpeta seleccionada. Abre Path en tu iPhone para importarla.",
  completeDownloadBody: "Tu base de datos se descargó automáticamente. Abre Path en tu iPhone para importarla.",
  savedStatus: "Guardado en disco",
  downloadAgainLabel: "Descargar de nuevo",
  chooseAnotherLabel: "Elegir otra copia",
  errorTitle: "Esta carpeta no fue reconocida",
  errorFallback: "Elige la carpeta o archivo ZIP con datos de Arc Export, Arc Previous Backups o Moves.",
  errorUnknownTitle: "Ocurrió un error",
  privacyStatement:
    "Path Import está diseñado para funcionar sin conexión: todo se procesa en tu dispositivo sin subirse a ningún servidor.",
  statsSummary: "Resumen de la cronología",
  statsDays: "días",
  statsStays: "estancias",
  statsMoves: "desplazamientos",
  statsPois: "lugares",
  handoffTitle: "Cómo importar en Path en tu iPhone",
  handoffStep1: "Transfiere el archivo .sqlite a tu iPhone mediante AirDrop o iCloud Drive.",
  handoffStep2: "Abre Path en tu iPhone y ve a Ajustes → Datos y almacenamiento.",
  handoffStep3: "Toca «Importar desde SQLite» y selecciona este archivo.",
};

const allTranslations: Record<LocaleCode, TranslationStrings> = {
  en: enTranslations,
  "zh-Hans": zhHansTranslations,
  "zh-Hant": zhHantTranslations,
  ja: jaTranslations,
  ko: koTranslations,
  de: deTranslations,
  fr: frTranslations,
  es: esTranslations,
  pt: {
    ...enTranslations,
    heroTitle: "Converta backups do Arc e Moves localmente",
    heroBody: "Selecione uma pasta de backup ou arquivo ZIP. O Path Import gera a base de dados no dispositivo.",
    selectFolderLabel: "Selecionar pasta de backup",
    selectZipLabel: "ou selecionar arquivo .zip",
    dropZonePrompt: "Arraste a pasta ou .zip para cá",
    workingTitle: "Convertendo dados",
    cancelLabel: "Cancelar conversão",
    completeTitle: "Arquivo de importação pronto",
    savedStatus: "Salvo no disco",
    downloadAgainLabel: "Baixar novamente",
    chooseAnotherLabel: "Escolher outro backup",
    statsSummary: "Resumo da Linha do Tempo",
    statsDays: "dias",
    statsStays: "paradas",
    statsMoves: "deslocamentos",
    statsPois: "locais",
    handoffTitle: "Como importar no Path no iPhone",
    handoffStep1: "Envie o arquivo .sqlite para seu iPhone via AirDrop ou iCloud Drive.",
    handoffStep2: "Abra o Path no iPhone e acesse Ajustes → Dados e Armazenamento.",
    handoffStep3: "Toque em «Importar do SQLite» e selecione este arquivo.",
    privacyStatement:
      "O Path Import foi projetado para funcionar offline: todos os arquivos selecionados são lidos e convertidos localmente neste dispositivo, sem nenhum envio de dados. Depois que a página carregar, você pode desconectar da internet.",
  },
  it: {
    ...enTranslations,
    heroTitle: "Converti i backup di Arc e Moves localmente",
    heroBody: "Seleziona una cartella o file ZIP. Path Import crea il database direttamente sul dispositivo.",
    selectFolderLabel: "Seleziona cartella di backup",
    selectZipLabel: "oppure seleziona archivio .zip",
    dropZonePrompt: "Trascina qui la cartella o il file .zip",
    workingTitle: "Conversione dei dati in corso",
    cancelLabel: "Annulla conversione",
    completeTitle: "File pronto per l'importazione",
    savedStatus: "Salvato su disco",
    downloadAgainLabel: "Scarica di nuovo",
    chooseAnotherLabel: "Scegli un altro backup",
    statsSummary: "Riepilogo cronologia",
    statsDays: "giorni",
    statsStays: "soste",
    statsMoves: "spostamenti",
    statsPois: "luoghi",
    handoffTitle: "Come importare in Path su iPhone",
    handoffStep1: "Trasferisci il file .sqlite sul tuo iPhone tramite AirDrop o iCloud Drive.",
    handoffStep2: "Apri Path su iPhone, vai in Impostazioni → Dati e archiviazione.",
    handoffStep3: "Tocca «Importa da SQLite» e seleziona questo file.",
    privacyStatement:
      "Path Import è progettato per funzionare offline: tutti i file selezionati vengono letti e convertiti interamente su questo dispositivo, senza alcun caricamento. Una volta caricata la pagina, puoi disconnetterti da Internet.",
  },
  nl: {
    ...enTranslations,
    heroTitle: "Converteer Arc- en Moves-backups lokaal",
    heroBody: "Selecteer een backupmap of zipbestand. Path Import maakt lokaal een databasebestand aan.",
    selectFolderLabel: "Selecteer backupmap",
    selectZipLabel: "of kies een .zip-bestand",
    dropZonePrompt: "Sleep backupmap of .zip hierheen",
    workingTitle: "Gegevens converteren",
    cancelLabel: "Conversie annuleren",
    completeTitle: "Importbestand gereed",
    savedStatus: "Opgeslagen op schijf",
    downloadAgainLabel: "Opnieuw downloaden",
    chooseAnotherLabel: "Kies andere backup",
    statsSummary: "Tijdlijnoverzicht",
    statsDays: "dagen",
    statsStays: "verblijven",
    statsMoves: "ritten & wandelingen",
    statsPois: "plekken",
    handoffTitle: "Zo importeer je in Path op de iPhone",
    handoffStep1: "Stuur het .sqlite-bestand naar je iPhone via AirDrop of iCloud Drive.",
    handoffStep2: "Open Path op je iPhone en ga naar Instellingen → Gegevens & Opslag.",
    handoffStep3: "Tik op 'Importeren vanuit SQLite' en selecteer dit bestand.",
    privacyStatement:
      "Path Import is ontworpen om offline te werken: alle geselecteerde bestanden worden volledig lokaal op dit apparaat gelezen en geconverteerd, zonder uploads. Zodra de pagina is geladen, kun je de internetverbinding verbreken.",
  },
  da: {
    ...enTranslations,
    selectFolderLabel: "Vælg backup-mappe",
    selectZipLabel: "eller vælg .zip-arkiv",
    privacyStatement:
      "Path Import er designet til at fungere offline: alle valgte filer læses og konverteres udelukkende lokalt på denne enhed uden upload. Når siden er indlæst, kan du afbryde internetforbindelsen.",
  },
  fi: {
    ...enTranslations,
    selectFolderLabel: "Valitse varmuuskopiokansio",
    selectZipLabel: "tai valitse .zip-arkisto",
    privacyStatement:
      "Path Import on suunniteltu toimimaan offline-tilassa: kaikki valitut tiedostot luetaan ja muunnetaan täysin paikallisesti tällä laitteella ilman tiedonsiirtoa verkkoon. Kun sivu on ladattu, voit katkaista internetyhteyden.",
  },
  sv: {
    ...enTranslations,
    selectFolderLabel: "Välj backupmapp",
    selectZipLabel: "eller välj .zip-arkiv",
    privacyStatement:
      "Path Import är utformat för att fungera offline: alla valda filer läses och konverteras helt lokalt på denna enhet, utan uppladdningar. När sidan har laddats kan du koppla från internet.",
  },
  pl: {
    ...enTranslations,
    selectFolderLabel: "Wybierz folder kopii zapasowej",
    selectZipLabel: "lub wybierz archiwum .zip",
    privacyStatement:
      "Path Import został zaprojektowany do pracy w trybie offline: wszystkie wybrane pliki są odczytywane i konwertowane w całości lokalnie na tym urządzeniu, bez wysyłania danych. Po załadowaniu strony możesz odłączyć się od internetu.",
  },
  uk: {
    ...enTranslations,
    selectFolderLabel: "Вибрати папку резервної копії",
    selectZipLabel: "або вибрати .zip архів",
    privacyStatement:
      "Path Import створено для автономної роботи: усі вибрані файли читаються та конвертуються виключно локально на цьому пристрої без завантаження в мережу. Після завантаження сторінки ви можете відключити інтернет.",
  },
  id: {
    ...enTranslations,
    selectFolderLabel: "Pilih folder cadangan",
    selectZipLabel: "atau pilih arsip .zip",
    privacyStatement:
      "Path Import dirancang untuk bekerja secara offline: semua file yang Anda pilih dibaca dan dikonversi sepenuhnya di perangkat ini, tanpa unggahan apa pun. Setelah halaman dimuat, Anda dapat memutus koneksi internet.",
  },
  th: {
    ...enTranslations,
    selectFolderLabel: "เลือกโฟลเดอร์สำรองข้อมูล",
    selectZipLabel: "หรือเลือกไฟล์ .zip",
    privacyStatement:
      "Path Import ได้รับการออกแบบให้ทำงานแบบออฟไลน์: ไฟล์ทั้งหมดที่คุณเลือกจะถูกอ่านและแปลงข้อมูลภายในอุปกรณ์นี้โดยสมบูรณ์ โดยไม่มีการอัปโหลดข้อมูลใดๆ เมื่อหน้าเว็บโหลดเสร็จแล้ว คุณสามารถตัดการเชื่อมต่ออินเทอร์เน็ตได้ทันที",
  },
  vi: {
    ...enTranslations,
    selectFolderLabel: "Chọn thư mục sao lưu",
    selectZipLabel: "hoặc chọn tệp .zip",
    privacyStatement:
      "Path Import được thiết kế để hoạt động ngoại tuyến: tất cả các tệp bạn chọn được đọc và chuyển đổi hoàn toàn cục bộ trên thiết bị này mà không tải lên bất kỳ dữ liệu nào. Sau khi trang tải xong, bạn có thể ngắt kết nối internet.",
  },
};

export function detectLocale(): LocaleCode {
  if (typeof window === "undefined") {
    return "en";
  }
  try {
    const saved = localStorage.getItem("path_import_locale") as LocaleCode | null;
    if (saved && allTranslations[saved]) {
      return saved;
    }
    const navLangs = navigator.languages || [navigator.language || "en"];
    for (const lang of navLangs) {
      const normalized = lang.toLowerCase();
      if (normalized.startsWith("zh-cn") || normalized.startsWith("zh-sg") || normalized === "zh-hans") {
        return "zh-Hans";
      }
      if (
        normalized.startsWith("zh-tw") ||
        normalized.startsWith("zh-hk") ||
        normalized.startsWith("zh-mo") ||
        normalized === "zh-hant"
      ) {
        return "zh-Hant";
      }
      for (const locale of SUPPORTED_LOCALES) {
        if (normalized === locale.code.toLowerCase() || normalized.startsWith(`${locale.code.toLowerCase()}-`)) {
          return locale.code;
        }
      }
    }
  } catch {
    // Ignore storage/navigator issues
  }
  return "en";
}

export function getTranslations(locale: LocaleCode): TranslationStrings {
  return allTranslations[locale] || enTranslations;
}
