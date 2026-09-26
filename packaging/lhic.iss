; LHIC 的安装程序（Inno Setup 6）。
;
; 编译：
;   ISCC.exe /DAppVersion=0.1.0 /DProduct=LHIC /DSourceDir=<发布包目录> /DOutputDir=<输出目录> packaging\lhic.iss
; 或者直接跑 `node packaging/build-desktop.mjs`（它会先打发布包，再调这里）。
;
; 三条设计决定，都是为了「卸载不做坏事」：
; 1. **按用户安装**（`PrivilegesRequired=lowest`）：不需要管理员，装到自己的 AppData 下，
;    这也和「本地 AI 工具」的定位一致 —— 它不该要系统权限。
; 2. **数据目录默认不动**：包把 data\ 放在安装目录里，卸载时**默认保留**（见下面 [UninstallDelete]）。
;    人在里面存的是画布和生成结果，那是作品，不是缓存。
; 3. **不捆绑 ComfyUI**：它是 GPL-3.0，而这份产品是专有许可（见 LICENSE）。安装包里只有
;    LHIC 自己；出图后端由首启向导填一个地址指向用户自己的 ComfyUI，不复制任何文件。

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef Product
  #define Product "LHIC"
#endif
#ifndef SourceDir
  #define SourceDir "..\dist-desktop\LHIC"
#endif
#ifndef OutputDir
  #define OutputDir "..\dist-desktop"
#endif
#ifndef LangDir
  #define LangDir "..\packaging\languages"
#endif

[Setup]
AppId={{7E2C9A54-3F1B-4C77-9E4A-5D2B8F01C3A6}
AppName={#Product}
AppVersion={#AppVersion}
AppVerName={#Product} {#AppVersion}
AppPublisher=LHIC
DefaultDirName={localappdata}\{#Product}
DefaultGroupName={#Product}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename={#Product}-{#AppVersion}-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
LicenseFile=..\LICENSE
UninstallDisplayName={#Product} {#AppVersion}
UninstallDisplayIcon={app}\icon.ico
; 图标：开始菜单、快捷方式、卸载列表里那张脸（就是包里那份印章标记）。
; 必须是 .ico —— Inno 收 PNG 会直接报 "Icon file is invalid"。
SetupIconFile={#SourceDir}\icon.ico

[Languages]
; 简体中文的 .isl **不在** Inno Setup 自带的那批里，所以随仓库带了一份
; （见 packaging\languages\README.md 的来源与授权）。
Name: "chinese"; MessagesFile: "{#LangDir}\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "在桌面上放一个快捷方式"; GroupDescription: "快捷方式："; Flags: unchecked

[Files]
; 发布包里有：node\（自带运行时）、app\（程序，服务端已打包压缩）、electron\（应用窗口）、
; desktop\（窗口外壳与端口探测）、launch.mjs（启动器）、icon.png、version.json。
; `data\` 不在包里（构建时不存在），所以它在第一次运行时才创建。
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; 快捷方式指向那个 .cmd 启动器，但**图标用我们自己的**：
; 不写 IconFilename 的话开始菜单里会是一个黑底白字的 cmd 图标。
Name: "{group}\{#Product}"; Filename: "{app}\启动 {#Product}.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"
Name: "{group}\卸载 {#Product}"; Filename: "{uninstallexe}"; IconFilename: "{app}\icon.ico"
Name: "{autodesktop}\{#Product}"; Filename: "{app}\启动 {#Product}.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\启动 {#Product}.cmd"; Description: "现在就启动"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
; 卸载**只删程序**：`app\`（自带那份程序）、`node\`（运行时）、`versions\`（自助更新装下来的那些版本）。
;
; **data\ 一个字都不删。** 里面是画布、生成的图和上传的素材 —— 那是作品，不是缓存。
; 所以这里没有 data 的规则；想彻底清干净的人删掉整个安装目录即可，
; 卸载时也会弹一句提醒（见下面的 [Code]），「使用说明.txt」里同样写着。
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\node"
Type: filesandordirs; Name: "{app}\versions"

[Code]
// 卸载时提醒一句：数据还在原地。
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    if DirExists(ExpandConstant('{app}\data')) then
      MsgBox('你的作品还在：' + ExpandConstant('{app}\data') + #13#10 +
             '卸载程序没有删它。确认不再需要之后，手动删掉整个安装目录即可。',
             mbInformation, MB_OK);
  end;
end;
