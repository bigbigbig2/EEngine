/**
 * meshoptimizer：负责几何数据、Meshlet 或空间结构处理。
 */

// @ts-nocheck

export const meshoptimizer = (() => {
  var e,
    t = new Uint8Array([
      32, 0, 65, 2, 1, 106, 34, 33, 3, 128, 11, 4, 13, 64, 6, 253, 10, 7, 15, 116, 127, 5, 8, 12,
      40, 16, 19, 54, 20, 9, 27, 255, 113, 17, 42, 67, 24, 23, 146, 148, 18, 14, 22, 45, 70, 69, 56,
      114, 101, 21, 25, 63, 75, 136, 108, 28, 118, 29, 73, 115
    ]);
  if ("object" != typeof WebAssembly) return { supported: !1 };
  function n(e) {
    if (!e) throw new Error("Assertion failed");
  }
  function r(e) {
    return new Uint8Array(e.buffer, e.byteOffset, e.byteLength);
  }
  function s(t, n, s, a, i, o, _, c, d, u) {
    var l = e.exports.sbrk,
      f = l(16 * e.exports.meshopt_buildMeshletsBound(n.length, o, _)),
      h = l(4 * n.length),
      m = l(n.length),
      g = l(n.byteLength),
      p = l(s.byteLength),
      v = new Uint8Array(e.exports.memory.buffer);
    (v.set(r(n), g), v.set(r(s), p));
    for (
      var A = t(f, h, m, g, n.length, p, a, i, o, _, c, d, u),
        b = (v = new Uint8Array(e.exports.memory.buffer)).subarray(f, f + 16 * A),
        w = new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4).slice(),
        x = 0;
      x < A;
      ++x
    )
      e.exports.meshopt_optimizeMeshlet(
        h + 4 * w[4 * x + 0],
        m + w[4 * x + 1],
        w[4 * x + 3],
        (a = w[4 * x + 2])
      );
    var y = w[4 * (A - 1) + 1] + 3 * w[4 * (A - 1) + 3],
      B = {
        meshlets: w,
        vertices: new Uint32Array(v.buffer, h, w[4 * (A - 1) + 0] + w[4 * (A - 1) + 2]).slice(),
        triangles: new Uint8Array(v.buffer, m, 3 * y).slice(),
        meshletCount: A
      };
    return (l(f - l(0)), B);
  }
  function a(t) {
    var n = new Float32Array(e.exports.memory.buffer, t, 12);
    return {
      centerX: n[0],
      centerY: n[1],
      centerZ: n[2],
      radius: n[3],
      coneApexX: n[4],
      coneApexY: n[5],
      coneApexZ: n[6],
      coneAxisX: n[7],
      coneAxisY: n[8],
      coneAxisZ: n[9],
      coneCutoff: n[10]
    };
  }
  const wasmBytes = (() => {
        for (var e = new Uint8Array(18682), n = 0; n < 18682; ++n) {
          var r =
            "b9H79Tebbbe95x9Geueu9Geub9Gbb9Giuuueu9Gmuuuuuuuuuuu9999eu9Gvuuuuueu9Gruuuuuuub9Gxuuuuuuuuuuuueu9Gxuuuuuuuuuuu99eu9GPuuuuuuuuuuuuu99b9Gouuuuuub9GluuuubiXCdilvorwDoqooqkbiibeilve9Weiiviebeoweuecj:Pdkr;Zeqo9TW9T9VV95dbH9F9F939H79T9F9J9H229F9Jt9VV7bb8A9TW79O9V9Wt9F9I919P29K9nW79O2Wt79c9V919U9KbeY9TW79O9V9Wt9F9I919P29K9nW79O2Wt7S2W94bd39TW79O9V9Wt9F9I919P29K9nW79O2Wt79t9W9Ht9P9H2bo39TW79O9V9Wt9F9J9V9T9W91tWJ2917tWV9c9V919U9K7bD39TW79O9V9Wt9F9J9V9T9W91tW9nW79O2Wt9c9V919U9K7bkE9TW79O9V9Wt9F9J9V9T9W91tW9t9W9OWVW9c9V919U9K7bxL9TW79O9V9Wt9F9V9Wt9P9T9P96W9nW79O2Wtbml79IV9RbPDwebcekdHOq:m:ceCdbkIbabaec9:fgefcufae9Ugeabci9Uadfcufad9Ugbaeab0Ek;x8JDPue99eux99due99euo99iu8Jjjjjbc:WD9Rgm8KjjjjbdndnalmbcbhPxekamc:Cwfcbc;Kbz:qjjjb8Adndnalcb9imbaoal9nmbamcuaocdtaocFFFFi0Egscbyd;01jjbHjjjjbbgzBd:CwamceBd;8wamascbyd;01jjbHjjjjbbgHBd:GwamcdBd;8wamcualcdtalcFFFFi0Ecbyd;01jjbHjjjjbbgOBd:KwamciBd;8waihsalhAinazasydbcdtfcbBdbasclfhsaAcufgAmbkaihsalhAinazasydbcdtfgCaCydbcefBdbasclfhsaAcufgAmbkaihsalhCcbhXindnazasydbcdtgQfgAydbcb9imbaHaQfaXBdbaAaAydbgQcjjjj94VBdbaQaXfhXkasclfhsaCcufgCmbkalci9UhLdnalci6mbcbhsaihAinaAcwfydbhCaAclfydbhXaHaAydbcdtfgQaQydbgQcefBdbaOaQcdtfasBdbaHaXcdtfgXaXydbgXcefBdbaOaXcdtfasBdbaHaCcdtfgCaCydbgCcefBdbaOaCcdtfasBdbaAcxfhAaLascefgs9hmbkkaihsalhAindnazasydbcdtgCfgXydbgQcu9kmbaXaQcFFFFrGgQBdbaHaCfgCaCydbaQ9RBdbkasclfhsaAcufgAmbxdkkamcuaocdtgsaocFFFFi0EgAcbyd;01jjbHjjjjbbgzBd:CwamceBd;8wamaAcbyd;01jjbHjjjjbbgHBd:GwamcdBd;8wamcualcdtalcFFFFi0Ecbyd;01jjbHjjjjbbgOBd:KwamciBd;8wazcbasz:qjjjbhXalci9UhLaihsalhAinaXasydbcdtfgCaCydbcefBdbasclfhsaAcufgAmbkdnaoTmbcbhsaHhAaXhCaohQinaAasBdbaAclfhAaCydbasfhsaCclfhCaQcufgQmbkkdnalci6mbcbhsaihAinaAcwfydbhCaAclfydbhQaHaAydbcdtfgKaKydbgKcefBdbaOaKcdtfasBdbaHaQcdtfgQaQydbgQcefBdbaOaQcdtfasBdbaHaCcdtfgCaCydbgCcefBdbaOaCcdtfasBdbaAcxfhAaLascefgs9hmbkkaoTmbcbhsaohAinaHasfgCaCydbaXasfydb9RBdbasclfhsaAcufgAmbkkamaLcbyd;01jjbHjjjjbbgsBd:OwamclBd;8wascbaLz:qjjjbhYamcuaLcK2alcjjjjd0Ecbyd;01jjbHjjjjbbg8ABd:SwamcvBd;8wJbbbbhEdnalci6g3mbarcd4hKaihAa8AhsaLhrJbbbbh5inavaAclfydbaK2cdtfgCIdlh8EavaAydbaK2cdtfgXIdlhEavaAcwfydbaK2cdtfgQIdlh8FaCIdwhaaXIdwhhaQIdwhgasaCIdbg8JaXIdbg8KMaQIdbg8LMJbbnn:vUdbasclfaXIdlaCIdlMaQIdlMJbbnn:vUdbaQIdwh8MaCIdwh8NaXIdwhyascxfa8EaE:tg8Eagah:tggNa8FaE:tg8Faaah:tgaN:tgEJbbbbJbbjZa8Ja8K:tg8Ja8FNa8La8K:tg8Ka8EN:tghahNaEaENaaa8KNaga8JN:tgEaENMM:rg8K:va8KJbbbb9BEg8ENUdbasczfaEa8ENUdbascCfaha8ENUdbascwfa8Maya8NMMJbbnn:vUdba5a8KMh5aAcxfhAascKfhsarcufgrmbka5aL:Z:vJbbbZNhEkamcuaLcdtalcFFFF970Ecbyd;01jjbHjjjjbbgCBd:WwamcoBd;8waq:Zhhdna3mbcbhsaChAinaAasBdbaAclfhAaLascefgs9hmbkkaEahNhhamcuaLcltalcFFFFd0Ecbyd;01jjbHjjjjbbg8PBd:0wamcrBd;8wcba8Pa8AaCaLz:djjjb8AJFFuuh8MJFFuuh8NJFFuuhydnalci6mbJFFuuhya8AhsaLhAJFFuuh8NJFFuuh8MinascwfIdbgEa8Ma8MaE9EEh8MasclfIdbgEa8Na8NaE9EEh8NasIdbgEayayaE9EEhyascKfhsaAcufgAmbkkah:rhEamaocetgscuaocu9kEcbyd;01jjbHjjjjbbgCBd:4wdndnaoal9nmbaihsalhAinaCasydbcetfcFFi87ebasclfhsaAcufgAmbxdkkaCcFeasz:qjjjb8AkaEJbbbZNh8JcuhIdnalci6mbcbhAJFFuuhEa8AhscuhIinascwfIdba8M:tghahNasIdbay:tghahNasclfIdba8N:tghahNMM:rghaEaIcuSahaE9DVgXEhEaAaIaXEhIascKfhsaLaAcefgA9hmbkkamczfcbcjwz:qjjjb8Aamcwf9cb83ibam9cb83iba8JaxNh8RJbbjZak:th8Lcbh8SJbbbbhRJbbbbh8UJbbbbh8VJbbbbh8WJbbbbh8XJbbbbh8Ycbh8ZcbhPinJbbbbhEdna8STmbJbbjZa8S:Z:vhEkJbbbbhhdna8Ya8YNa8Wa8WNa8Xa8XNMMg8KJbbbb9BmbJbbjZa8K:r:vhhka8VaENh8Ka8UaENh8EaRaENh5aIhLdndndndndna8SaPVTmbamydwg80Tmea8YahNh8Fa8XahNhaa8WahNhgaeamydbcdtfh81cbh3JFFuuhEcvhQcuhLindnaza81a3cdtfydbcdtgsfydbgvTmbaOaHasfydbcdtfhAindndnaCaiaAydbgKcx2fgsclfydbgrcetf8Vebcs4aCasydbgXcetf8Vebcs4faCascwfydbglcetf8Vebcs4fgombcbhsxekcehsazaXcdtfydbgXceSmbcehsazarcdtfydbgrceSmbcehsazalcdtfydbglceSmbdnarcdSaXcdSfalcdSfcd6mbaocefhsxekaocdfhskdnasaQ9kmba8AaKcK2fgXIdwa8K:tghahNaXIdba5:tghahNaXIdla8E:tghahNMM:ra8J:va8LNJbbjZMJ9VO:d86JbbjZaXIdCa8FNaXIdxagNaaaXIdzNMMakN:tghahJ9VO:d869DENghaEasaQ6ahaE9DVgXEhEaKaLaXEhLasaQaXEhQkaAclfhAavcufgvmbkka3cefg3a809hmbkkaLcu9hmekama8KUd:ODama8EUd:KDama5Ud:GDamcuBd:qDamcFFF;7rBdjDa8Pcba8AaYamc:GDfamc:qDfamcjDfz:ejjjbamyd:qDhLdndnaxJbbbb9ETmba8SaD6mbaLcuSmeceh3amIdjDa8R9EmixdkaLcu9hmekdna8STmbabaPcltfgzam8Pib83dbazcwfamcwf8Pib83dbaPcefhPkc3hzinazc98Smvamc:Cwfazfydbcbyd;41jjbH:bjjjbbazc98fhzxbkkcbh3a8Saq9pmbamydwaCaiaLcx2fgsydbcetf8Vebcs4aCascwfydbcetf8Vebcs4faCasclfydbcetf8Vebcs4ffaw9nmekcbhscbhAdna8ZTmbcbhAamczfhXinamczfaAcdtfaXydbgQBdbaXclfhXaAaYaQfRbbTfhAa8Zcufg8ZmbkkamydwhlamydbhXam9cu83i:GDam9cu83i:ODam9cu83i:qDam9cu83i:yDaAc;8eaAclfc:bd6Eh8ZinamcjDfasfcFFF;7rBdbasclfgscz9hmbka8Zcdth80dnalTmbaeaXcdtfhocbhrindnazaoarcdtfydbcdtgsfydbgvTmbaOaHasfydbcdtfhAcuhQcuhsinazaiaAydbgKcx2fgXclfydbcdtfydbazaXydbcdtfydbfazaXcwfydbcdtfydbfgXasaXas6gXEhsaKaQaXEhQaAclfhAavcufgvmbkaQcuSmba8AaQcK2fgAIdwa8M:tgEaENaAIdbay:tgEaENaAIdla8N:tgEaENMM:rhEcbhAindndnasamc:qDfaAfgvydbgX6mbasaX9hmeaEamcjDfaAfIdb9FTmekavasBdbamc:GDfaAfaQBdbamcjDfaAfaEUdbxdkaAclfgAcz9hmbkkarcefgral9hmbkkamczfa80fhQcbhscbhAindnamc:GDfasfydbgXcuSmbaQaAcdtfaXBdbaAcefhAkasclfgscz9hmbkaAa8Zfg8ZTmbJFFuuhhcuhKamczfhsa8ZhvcuhQina8AasydbgXcK2fgAIdwa8M:tgEaENaAIdbay:tgEaENaAIdla8N:tgEaENMM:rhEdndnazaiaXcx2fgAclfydbcdtfydbazaAydbcdtfydbfazaAcwfydbcdtfydbfgAaQ6mbaAaQ9hmeaEah9DTmekaEhhaAhQaXhKkasclfhsavcufgvmbkaKcuSmbaKhLkdnamaiaLcx2fgrydbarclfydbarcwfydbaCabaeadaPawaqa3z:fjjjbTmbaPcefhPJbbbbhRJbbbbh8UJbbbbh8VJbbbbh8WJbbbbh8XJbbbbh8YkcbhXinaOaHaraXcdtfydbcdtgAfydbcdtfgKhsazaAfgvydbgQhAdnaQTmbdninasydbaLSmeasclfhsaAcufgATmdxbkkasaKaQcdtfc98fydbBdbavavydbcufBdbkaXcefgXci9hmbka8AaLcK2fgsIdbhEasIdlhhasIdwh8KasIdxh8EasIdzh5asIdCh8FaYaLfce86bba8Ya8FMh8Ya8Xa5Mh8Xa8Wa8EMh8Wa8Va8KMh8Va8UahMh8UaRaEMhRamydxh8Sxbkkamc:WDf8KjjjjbaPk;Vvivuv99lu8Jjjjjbca9Rgv8Kjjjjbdndnalcw0mbaiydbhoaeabcitfgralcdtciVBdlaraoBdbdnalcd6mbaiclfhoalcufhwarcxfhrinaoydbhDarcuBdbarc98faDBdbarcwfhraoclfhoawcufgwmbkkalabfhrxekcbhDavczfcwfcbBdbav9cb83izavcwfcbBdbav9cb83ibJbbjZhqJbbjZhkinadaiaDcdtfydbcK2fhwcbhrinavczfarfgoawarfIdbgxaoIdbgm:tgPakNamMgmUdbavarfgoaPaxam:tNaoIdbMUdbarclfgrcx9hmbkJbbjZaqJbbjZMgq:vhkaDcefgDal9hmbkcbhoadcbcecdavIdlgxavIdwgm9GEgravIdbgPam9GEaraPax9GEgscdtgrfhzavczfarfIdbhxaihralhwinaiaocdtfgDydbhHaDarydbgOBdbaraHBdbarclfhraoazaOcK2fIdbax9Dfhoawcufgwmbkaeabcitfhrdndnaocv6mbaoalc98f6mekaraiydbBdbaralcdtciVBdlaiclfhoalcufhwarcxfhrinaoydbhDarcuBdbarc98faDBdbarcwfhraoclfhoawcufgwmbkalabfhrxekaraxUdbararydlc98GasVBdlabcefaeadaiaoz:djjjbhwararydlciGawabcu7fcdtVBdlawaeadaiaocdtfalao9Rz:djjjbhrkavcaf8Kjjjjbark;yddvue99dninabaecitfgrydlgwcl6mednawciGgDci9hmbabaecitfhbcbhecehqindnaiabydbgDfRbbmbcbhqadaDcK2fgkIdwalIdw:tgxaxNakIdbalIdb:tgxaxNakIdlalIdl:tgxaxNMM:rgxaoIdb9DTmbaoaxUdbavaDBdbarydlhwkabcwfhbaecefgeawcd46mbkaqceGTmdarawciGBdlskdnabcbawcd4gwalaDcdtfIdbarIdb:tgxJbbbb9FEgkaw7aecefgwfgecitfydlabakawfgwcitfydlVci0mbaraDBdlkabawadaialavaoz:ejjjbax:laoIdb9Fmbkkkjlevudnabydwgxaladcetfgm8Vebcs4alaecetfgP8Vebgscs4falaicetfgz8Vebcs4ffaD0abydxaq9pVakVgDce9hmbavawcltfgxab8Pdb83dbaxcwfabcwfgx8Pdb83dbabydbhqdnaxydbgkTmbaoaqcdtfhxakhsinalaxydbcetfcFFi87ebaxclfhxascufgsmbkkabaqakfBdbabydxhxab9cb83dwababydlaxci2fBdlaP8Vebhscbhxkdnascztcz91cu9kmbabaxcefBdwaPax87ebaoabydbcdtfaxcdtfaeBdbkdnam8Uebcu9kmbababydwgxcefBdwamax87ebaoabydbcdtfaxcdtfadBdbkdnaz8Uebcu9kmbababydwgxcefBdwazax87ebaoabydbcdtfaxcdtfaiBdbkarabydlfabydxci2faPRbb86bbarabydlfabydxci2fcefamRbb86bbarabydlfabydxci2fcdfazRbb86bbababydxcefBdxaDk:zPrHue99eue99eue99eu8Jjjjjbc;W;Gb9Rgx8KjjjjbdndnalmbcbhmxekcbhPaxc:m;Gbfcbc;Kbz:qjjjb8Aaxcualci9UgscltascjjjjiGEcbyd;01jjbHjjjjbbgzBd:m9GaxceBd;S9GaxcuascK2gHcKfalcpFFFe0Ecbyd;01jjbHjjjjbbgOBd:q9GaxcdBd;S9Gdnalci6gAmbarcd4hCascdthXaOhQazhLinavaiaPcx2fgrydbaC2cdtfhKavarcwfydbaC2cdtfhYavarclfydbaC2cdtfh8AcbhraLhEinaQarfgmaKarfg3Idbg5a8Aarfg8EIdbg8Fa5a8F9DEg5UdbamaYarfgaIdbg8Fa5a8Fa59DEg8FUdbamcxfgma3Idbg5a8EIdbgha5ah9EEg5UdbamaaIdbgha5aha59EEg5UdbaEa8Fa5MJbbbZNUdbaEaXfhEarclfgrcx9hmbkaQcKfhQaLclfhLaPcefgPas9hmbkkaOaHfgr9cb83dbarczf9cb83dbarcwf9cb83dbaxcuascx2gralc:bjjjl0Ecbyd;01jjbHjjjjbbgCBdN9GaxciBd;S9GascdthgazarfhvaChHazhLcbhPinaxcbcj;Gbz:qjjjbhEaPas2cdthadnaAmbaLhrash3inaEarydbgmc8F91cjjjj94Vam7gmcQ4cx2fg8Ea8EydwcefBdwaEamcd4cFrGcx2fg8Ea8EydbcefBdbaEamcx4cFrGcx2fgmamydlcefBdlarclfhra3cufg3mbkkazaafh8AaCaafhXcbhmcbh3cbh8EcbhainaEamfgrydbhQara3BdbarcwfgKydbhYaKaaBdbarclfgrydbhKara8EBdbaQa3fh3aYaafhaaKa8Efh8Eamcxfgmcj;Gb9hmbkdnaAmbcbhravhminamarBdbamclfhmasarcefgr9hmbkaAmbavhrashminaEa8Aarydbg3cdtfydbg8Ec8F91a8E7cd4cFrGcx2fg8Ea8Eydbg8EcefBdbaXa8Ecdtfa3BdbarclfhramcufgmmbkaHhrashminaEa8Aarydbg3cdtfydbg8Ec8F91a8E7cx4cFrGcx2fg8Ea8Eydlg8EcefBdlava8Ecdtfa3BdbarclfhramcufgmmbkavhrashminaEa8Aarydbg3cdtfydbg8Ec8F91cjjjj94Va8E7cQ4cx2fg8Ea8Eydwg8EcefBdwaXa8Ecdtfa3BdbarclfhramcufgmmbkkaHagfhHaLagfhLaPcefgPci9hmbkaEaocetgrcuaocu9kEcbyd;01jjbHjjjjbbgKBd:y9GaEclBd;S9Gdndnaoal9nmbaihralhminaKarydbcetfcFFi87ebarclfhramcufgmmbxdkkaKcFearz:qjjjb8AkcbhmaEascbyd;01jjbHjjjjbbg8ABd:C9GaOaCaCascdtfaCascitfa8AascbazaKaiawaDaqakz:hjjjbcbh8Ednalci6gambcbh8Ea8Ahrash3ina8EarRbbfh8Earcefhra3cufg3mbkkaEcwf9cb83ibaE9cb83ibalawc9:fgrfcufar9UhrasaDfcufaD9Uh3dnaambara3ara30EhYcbhra8Ehacbhmincbh3dnarTmba8AarfRbbceSh3kamaEaiaCydbcx2fgQydbaQclfydbaQcwfydbaKabaeadamawaqa3a3ce7a8EaY9nVaaamfaY6VGz:fjjjbfhmaCclfhCaaa8AarfRbb9Rhaasarcefgr9hmbkaEydxTmbabamcltfgraE8Pib83dbarcwfaEcwf8Pib83dbamcefhmkczhrinarc98SmeaEc:m;Gbfarfydbcbyd;41jjbH:bjjjbbarc98fhrxbkkaxc;W;Gbf8Kjjjjbamk;LXDXue99lue99iul9:eur99lu8Jjjjjbc;qb9RgP8Kjjjjbdndnaoc8Y9imbalaeavawaDaqaxz1jjjbxekaxhsaxhzdnavax0gHmbdnavTmbcbhOaehzavhAinawaDazydbcx2fgCcwfydbcetfgX8VebhQawaCclfydbcetfgL8VebhKawaCydbcetfgC8VebhYaXce87ebaLce87ebaCce87ebaOaKcs4aYcs4faQcs4ffhOazclfhzaAcufgAmbkaehzavhAinawaDazydbcx2fgCcwfydbcetfcFFi87ebawaCclfydbcetfcFFi87ebawaCydbcetfcFFi87ebazclfhzaAcufgAmbkcehzaqhsaOaq0mekalce86bbalcefcbavcufz:qjjjb8AxekaPaiBdxaPadBdwaPaeBdlavakaqci9UgCakaCak6EaHEgK9Rh8AaxaK9RhEaKcufh3aKceth5aKcdtgCc98fh8EavcitgOaC9Rarfc98fh8FascufhaavcufhharaOfhgJbbjZas:Y:vh8JaravcdtgYfc94fh8KcbazceakaxSEg8Lcdtg8M9Rh8NJFFuuhycuh8PcbhIcbh8RinaPclfa8RcdtfydbhQaPc8WfcKfcb8Pd:y1jjbg8S83ibaPc8Wfczfcb8Pd:q1jjbgR83ibaPc8Wfcwfcb8Pd11jjbg8U83ibaPcb8Pdj1jjbg8V83i8WaPczfcKfa8S83ibaPczfczfaR83ibaPczfcwfa8U83ibaPa8V83izaQaYfh8WcbhXinabaQaXcdtgLfydbcK2fhAcbhzinaPc8WfazfgCaAazfgOIdbg8XaCIdbg8Ya8Xa8Y9DEUdbaCczfgCaOcxfIdbg8XaCIdbg8Ya8Xa8Y9EEUdbazclfgzcx9hmbkaPIdnaPId8W:tg8ZaPId9iaPIdU:tg80Nh81aba8WaXcu7cdtfydbcK2fhAcbhzaPId80hBaPId9eh83inaPczfazfgCaAazfgOIdbg8XaCIdbg8Ya8Xa8Y9DEUdbaCczfgCaOcxfIdbg8XaCIdbg8Ya8Xa8Y9EEUdbazclfgzcx9hmbkaraLfgza83aB:tg8Xa80Na8Za8XNa81MMUdbazaYfaPId8KaPIdC:tg8XaPIdyaPIdK:tg8YNaPIdaaPIdz:tg8Za8XNa8Za8YNMMUdbaXcefgXav9hmbkcbhUdnaHmbcbhAaQhzaghCavhXinawaDazydbcx2fgOcwfydbcetfgL8Vebh8WawaOclfydbcetfg858VebhUawaOydbcetfgO8Vebh86aLce87eba85ce87ebaOce87ebaCaAaUcs4a86cs4fa8Wcs4ffgABdbazclfhzaCclfhCaXcufgXmbkavhCinawaDaQydbcx2fgzcwfydbcetfcFFi87ebawazclfydbcetfcFFi87ebawazydbcetfcFFi87ebaQclfhQaCcufgCmbkaghUkdndndndndndndndndndna5av0mba5ax0meavaK6mda3a8A9pmDcehLa8AhXaUTmlxrka3ah9pmwa5ax9nmdxlkdnavavaK9UgzaK29RazaE20mba3a8A9pmwaUTh87ceh85a8AhLxvka3ah6mixrka3ah9pmokcbhLahhXaUmikJFFuuh8XcbhQa3hzindnazcefgCaK6mbaLavaC9RgOaK6GmbarazcdtfIdbg8YaC:YNa8Kavaz9RcdtfIdbg8ZaO:YNMg80a8X9Embdndna8JaOaaf:YNg81:lJbbb9p9DTmba81:OhAxekcjjjj94hAka8ZasaA2aO9R:YNh8Zdndna8Jazasf:YNg81:lJbbb9p9DTmba81:OhOxekcjjjj94hOkamasaO2aC9R:Ya8YNa8ZMNa80Mg8Ya8Xa8Ya8X9DgOEh8XaCaQaOEhQkaza8LfgzaX6mbxlkkaUTh87cbh85ahhLkJFFuuh8XcbhQa8AhCa8FhAa8EhOaKhzindnazazaK9UgXaK29RaXaE20mbdna85TmbaCaCaK9UgXaK29RaXaE20mekaraOfIdbg8Yaz:YNaAIdbg8ZaC:YNMg80a8X9EmbazhXaCh8Wdna87mbaUaOfydbgXh8Wkdndna8Ja8Waaf:YNg81:lJbbb9p9DTmba81:Oh86xekcjjjj94h86ka8Zasa862a8W9R:YNh8Zdndna8JaXaaf:YNg81:lJbbb9p9DTmba81:Oh8Wxekcjjjj94h8Wkamasa8W2aX9R:Ya8YNa8ZMNa80Mg8Ya8Xa8Ya8X9DgXEh8XazaQaXEhQkaCa8L9RhCaAa8NfhAaOa8MfhOaza8LfgzcufaL6mbxdkkJFFuuh8XcbhQa8AhCa8FhAa8EhOaKhzindnazaK6mbaLaCaK6GmbaraOfIdbg8Yaz:YNaAIdbg8ZaC:YNMg80a8X9Embdndna8JaUaOfydbg8Waaf:YNg81:lJbbb9p9DTmba81:Oh85xekcjjjj94h85kamasa852a8W9R:Yg81a8YNa8Za81NMNa80Mg8Ya8Xa8Ya8X9Dg8WEh8XazaQa8WEhQkaCa8L9RhCaAa8NfhAaOa8MfhOaza8LfgzcufaX6mbkkaQTmba8Xay9DTmba8XhyaQhIa8Rh8Pka8Rcefg8Rci9hmbkdna8Pcb9ombalaeavawaDaqaxz1jjjbxekaravcdtg8WfhLdnaITmbaPclfa8PcdtfydbhzaIhCinaLazydbfcb86bbazclfhzaCcufgCmbkkdnavaI9nmbaPclfa8PcdtfydbaIcdtfhzavaI9RhCinaLazydbfce86bbazclfhzaCcufgCmbkkcbhYindnaYa8PSmbcbhzaraPclfaYcdtfydbgKa8Wz:pjjjbhCavhXaIhOinaKaOazaLaCydbgQfRbbgAEcdtfaQBdbaCclfhCaOaAfhOazaA9RcefhzaXcufgXmbkkaYcefgYci9hmbkabaeadaialaIaocefgCarawaDaqakaxamz:hjjjbabaeaIcdtgzfadazfaiazfalaIfavaI9RaCarawaDaqakaxamz:hjjjbkaPc;qbf8Kjjjjbk1iePudnadTmbavci9UgrcufhwcbhDindndndnadaD9RaoaDaofad0EgqTmbcbhkaeaDcdtfgxhmaqhPinaialamydbcx2fgscwfydbcetfgz8VebhHaiasclfydbcetfgO8VebhAaiasydbcetfgs8VebhCazce87ebaOce87ebasce87ebakaAcs4aCcs4faHcs4ffhkamclfhmaPcufgPmbkaqhsinaialaxydbcx2fgmcwfydbcetfcFFi87ebaiamclfydbcetfcFFi87ebaiamydbcetfcFFi87ebaxclfhxascufgsmbkakav0mekabaDfgxce86bbaxcefcbaqcufz:qjjjb8AxekabaDfgxce86bbaxcefcbawz:qjjjb8AarhqkaqaDfgDad6mbkkk;Nkovud99euv99eul998Jjjjjbc:W;ae9Rgo8KjjjjbdndnadTmbavcd4hrcbhwcbhDindnaiaeclfydbar2cdtfgvIdbaiaeydbar2cdtfgqIdbgk:tgxaiaecwfydbar2cdtfgmIdlaqIdlgP:tgsNamIdbak:tgzavIdlaP:tgPN:tgkakNaPamIdwaqIdwgH:tgONasavIdwaH:tgHN:tgPaPNaHazNaOaxN:tgxaxNMM:rgsJbbbb9Bmbaoc:W:qefawcx2fgAakas:vUdwaAaxas:vUdlaAaPas:vUdbaoc8Wfawc8K2fgAaq8Pdb83dbaAav8Pdb83dxaAam8Pdb83dKaAcwfaqcwfydbBdbaAcCfavcwfydbBdbaAcafamcwfydbBdbawcefhwkaecxfheaDcifgDad6mbkab9cb83dbabcyf9cb83dbabcaf9cb83dbabcKf9cb83dbabczf9cb83dbabcwf9cb83dbawTmeaocbBd8Sao9cb83iKao9cb83izaoczfaoc8Wfawci2cxaoc8Sfcbcrz:kjjjbaoIdKhCaoIdChXaoIdzhQao9cb83iwao9cb83ibaoaoc:W:qefawcxaoc8Sfcbciz:kjjjbJbbjZhkaoIdwgPJbbbbJbbjZaPaPNaoIdbgPaPNaoIdlgsasNMM:rgx:vaxJbbbb9BEgzNhxasazNhsaPazNhzaoc:W:qefheawhvinaecwfIdbaxNaeIdbazNasaeclfIdbNMMgPakaPak9DEhkaecxfheavcufgvmbkabaCUdwabaXUdlabaQUdbabaoId3UdxdndnakJ;n;m;m899FmbJbbbbhPaoc:W:qefheaoc8WfhvinaCavcwfIdb:taecwfIdbgHNaQavIdb:taeIdbgONaXavclfIdb:taeclfIdbgLNMMaxaHNazaONasaLNMM:vgHaPaHaP9EEhPavc8KfhvaecxfheawcufgwmbkabaxUd8KabasUdaabazUd3abaCaxaPN:tUdKabaXasaPN:tUdCabaQazaPN:tUdzabJbbjZakakN:t:rgkUdydndnaxJbbj:;axJbbj:;9GEgPJbbjZaPJbbjZ9FEJbb;:9cNJbbbZJbbb:;axJbbbb9GEMgP:lJbbb9p9DTmbaP:Ohexekcjjjj94hekabae86b8UdndnasJbbj:;asJbbj:;9GEgPJbbjZaPJbbjZ9FEJbb;:9cNJbbbZJbbb:;asJbbbb9GEMgP:lJbbb9p9DTmbaP:Ohvxekcjjjj94hvkabav86bRdndnazJbbj:;azJbbj:;9GEgPJbbjZaPJbbjZ9FEJbb;:9cNJbbbZJbbb:;azJbbbb9GEMgP:lJbbb9p9DTmbaP:Ohqxekcjjjj94hqkabaq86b8SdndnaecKtcK91:YJbb;:9c:vax:t:lavcKtcK91:YJbb;:9c:vas:t:laqcKtcK91:YJbb;:9c:vaz:t:lakMMMJbb;:9cNJbbjZMgk:lJbbb9p9DTmbak:Ohexekcjjjj94hekaecFbaecFb9iEhexekabcjjj;8iBdycFbhekabae86b8Vxekab9cb83dbabcyf9cb83dbabcaf9cb83dbabcKf9cb83dbabczf9cb83dbabcwf9cb83dbkaoc:W;aef8Kjjjjbk;Iwwvul99iud99eue99eul998Jjjjjbcje9Rgr8Kjjjjbavcd4hwaicd4hDdndnaoTmbarc;abfcbaocdtgvz:qjjjb8Aarc;Gbfcbavz:qjjjb8AarhvarcafhiaohqinavcFFF97BdbaicFFF;7rBdbaiclfhiavclfhvaqcufgqmbkdnadTmbcbhkinaeakaD2cdtfgvIdwhxavIdlhmavIdbhPalakaw2cdtfIdbhsarc;abfhzarhiarc;GbfhHarcafhqc:G1jjbhvaohOinasavcwfIdbaxNavIdbaPNavclfIdbamNMMgAMhCakhXdnaAas:tgAaqIdbgQ9DgLmbaHydbhXkaHaXBdbakhXdnaCaiIdbgK9EmbazydbhXaKhCkazaXBdbaiaCUdbaqaAaQaLEUdbavcxfhvaqclfhqaHclfhHaiclfhiazclfhzaOcufgOmbkakcefgkad9hmbkkadThkJbbbbhCcbhXarc;abfhvarc;Gbfhicbhqinalavydbgzaw2cdtfIdbalaiydbgHaw2cdtfIdbaeazaD2cdtfgzIdwaeaHaD2cdtfgHIdw:tgsasNazIdbaHIdb:tgsasNazIdlaHIdl:tgsasNMM:rMMgsaCasaC9EgzEhCaqaXazEhXaiclfhiavclfhvaoaqcefgq9hmbkaCJbbbZNhKxekadThkcbhXJbbbbhKkJbbbbhCdnaearc;abfaXcdtgifydbgqaD2cdtfgvIdwaearc;GbfaifydbgzaD2cdtfgiIdwgm:tgsasNavIdbaiIdbgY:tgAaANavIdlaiIdlgP:tgQaQNMM:rgxJbbbb9ETmbaxalaqaw2cdtfIdbMalazaw2cdtfIdb:taxaxM:vhCkasaCNamMhmaQaCNaPMhPaAaCNaYMhYdnakmbaDcdthvawcdthiindnalIdbg8AaecwfIdbam:tgCaCNaeIdbaY:tgsasNaeclfIdbaP:tgAaANMM:rgQMgEaK9ETmbJbbbbhxdnaQJbbbb9ETmbaEaK:taQaQM:vhxkaxaCNamMhmaxaANaPMhPaxasNaYMhYa8AaKaQMMJbbbZNhKkaeavfhealaifhladcufgdmbkkabaKUdxabamUdwabaPUdlabaYUdbarcjef8Kjjjjbkjeeiu8Jjjjjbcj8W9Rgr8Kjjjjbaici2hwdnaiTmbawceawce0EhDarhiinaiaeadRbbcdtfydbBdbadcefhdaiclfhiaDcufgDmbkkabarawaladaoz:jjjjbarcj8Wf8Kjjjjbk:Reeeu8Jjjjjbca9Rgo8Kjjjjbab9cb83dbabcyf9cb83dbabcaf9cb83dbabcKf9cb83dbabczf9cb83dbabcwf9cb83dbdnadTmbaocbBd3ao9cb83iwao9cb83ibaoaeadaialaoc3falEavcbalEcrz:kjjjbabao8Pib83dbabao8Piw83dwkaocaf8Kjjjjbk:3lequ8JjjjjbcjP9Rgl8Kjjjjbcbhvalcjxfcbaiz:qjjjb8AdndnadTmbcjehoaehrincuhwarhDcuhqavhkdninawakaoalcjxfaDcefRbbfRbb9RcFeGci6aoalcjxfaDRbbfRbb9RcFeGci6faoalcjxfaDcdfRbbfRbb9RcFeGci6fgxaq9mgmEhwdnammbaxce0mdkaxaqaxaq9kEhqaDcifhDadakcefgk9hmbkkaeawci2fgDcdfRbbhqaDcefRbbhxaDRbbhkaeavci2fgDcifaDawav9Rci2z:tjjjb8Aakalcjxffaocefgo86bbaxalcjxffao86bbaDcdfaq86bbaDcefax86bbaDak86bbaqalcjxffao86bbarcifhravcefgvad9hmbkalcFeaicetz:qjjjbhoadci2gDceaDce0EhqcbhxindnaoaeRbbgkcetfgw8UebgDcu9kmbawax87ebaocjlfaxcdtfabakcdtfydbBdbaxhDaxcefhxkaeaD86bbaecefheaqcufgqmbkaxcdthDxekcbhDkabalcjlfaDz:pjjjb8AalcjPf8Kjjjjbk9teiucbcbyd;81jjbgeabcifc98GfgbBd;81jjbdndnabZbcztgd9nmbcuhiabad9RcFFifcz4nbcuSmekaehikaik;teeeudndnaeabVciGTmbabhixekdndnadcz9pmbabhixekabhiinaiaeydbBdbaiaeydlBdlaiaeydwBdwaiaeydxBdxaeczfheaiczfhiadc9Wfgdcs0mbkkadcl6mbinaiaeydbBdbaeclfheaiclfhiadc98fgdci0mbkkdnadTmbinaiaeRbb86bbaicefhiaecefheadcufgdmbkkabk:3eedudndnabciGTmbabhixekaecFeGc:b:c:ew2hldndnadcz9pmbabhixekabhiinaialBdxaialBdwaialBdlaialBdbaiczfhiadc9Wfgdcs0mbkkadcl6mbinaialBdbaiclfhiadc98fgdci0mbkkdnadTmbinaiae86bbaicefhiadcufgdmbkkabk9teiucbcbyd;81jjbgeabcrfc94GfgbBd;81jjbdndnabZbcztgd9nmbcuhiabad9RcFFifcz4nbcuSmekaehikaik9:eiuZbhedndncbyd;81jjbgdaecztgi9nmbcuheadai9RcFFifcz4nbcuSmekadhekcbabae9Rcifc98Gcbyd;81jjbfgdBd;81jjbdnadZbcztge9nmbadae9RcFFifcz4nb8Akk:;Deludndndnadch9pmbabaeSmdaeabadfgi9Rcbadcet9R0mekabaead;8qbbxekaeab7ciGhldndndnabae9pmbdnalTmbadhvabhixikdnabciGmbadhvabhixdkadTmiabaeRbb86bbadcufhvdnabcefgiciGmbaecefhexdkavTmiabaeRbe86beadc9:fhvdnabcdfgiciGmbaecdfhexdkavTmiabaeRbd86bdadc99fhvdnabcifgiciGmbaecifhexdkavTmiabaeRbi86biabclfhiaeclfheadc98fhvxekdnalmbdnaiciGTmbadTmlabadcufgifglaeaifRbb86bbdnalciGmbaihdxekaiTmlabadc9:fgifglaeaifRbb86bbdnalciGmbaihdxekaiTmlabadc99fgifglaeaifRbb86bbdnalciGmbaihdxekaiTmlabadc98fgdfaeadfRbb86bbkadcl6mbdnadc98fgocd4cefciGgiTmbaec98fhlabc98fhvinavadfaladfydbBdbadc98fhdaicufgimbkkaocx6mbaec9Wfhvabc9WfhoinaoadfgicxfavadfglcxfydbBdbaicwfalcwfydbBdbaiclfalclfydbBdbaialydbBdbadc9Wfgdci0mbkkadTmdadhidnadciGglTmbaecufhvabcufhoadhiinaoaifavaifRbb86bbaicufhialcufglmbkkadcl6mdaec98fhlabc98fhvinavaifgecifalaifgdcifRbb86bbaecdfadcdfRbb86bbaecefadcefRbb86bbaeadRbb86bbaic98fgimbxikkavcl6mbdnavc98fglcd4cefcrGgdTmbavadcdt9RhvinaiaeydbBdbaeclfheaiclfhiadcufgdmbkkalc36mbinaiaeydbBdbaiaeydlBdlaiaeydwBdwaiaeydxBdxaiaeydzBdzaiaeydCBdCaiaeydKBdKaiaeyd3Bd3aecafheaicafhiavc9Gfgvci0mbkkavTmbdndnavcrGgdmbavhlxekavc94GhlinaiaeRbb86bbaicefhiaecefheadcufgdmbkkavcw6mbinaiaeRbb86bbaiaeRbe86beaiaeRbd86bdaiaeRbi86biaiaeRbl86blaiaeRbv86bvaiaeRbo86boaiaeRbr86braicwfhiaecwfhealc94fglmbkkabkk:nedbcjwktFFuuFFuuFFuubbbbFFuFFFuFFFuFbbbbbbjZbbbbbbbbbbbbbbjZbbbbbbbbbbbbbbjZ86;nAZ86;nAZ86;nAZ86;nA:;86;nAZ86;nAZ86;nAZ86;nA:;86;nAZ86;nAZ86;nAZ86;nA:;bc;0wkxebbbdbbbjNbb".charCodeAt(
              n
            );
          e[n] = r > 96 ? r - 97 : r > 64 ? r - 39 : r + 4;
        }
        var s = 0;
        for (n = 0; n < 18682; ++n) e[s++] = e[n] < 60 ? t[e[n]] : 64 * (e[n] - 60) + e[++n];
        return e.buffer.slice(0, s);
      })();
  e = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {});
  e.exports.__wasm_call_ctors();
  return {
    ready: Promise.resolve(),
    supported: !0,
    buildMeshlets(t, r, a, i, o, _) {
      (n(t.length % 3 == 0),
        n(r instanceof Float32Array),
        n(r.length % a == 0),
        n(a >= 3),
        n(i > 0 && i <= 256),
        n(o >= 1 && o <= 512),
        (_ = _ || 0));
      var c = 4 == t.BYTES_PER_ELEMENT ? t : new Uint32Array(t);
      return s(e.exports.meshopt_buildMeshletsFlex, c, r, r.length / a, 4 * a, i, o, o, _, 0);
    },
    buildMeshletsFlex(t, r, a, i, o, _, c, d) {
      (n(t.length % 3 == 0),
        n(r instanceof Float32Array),
        n(r.length % a == 0),
        n(a >= 3),
        n(i > 0 && i <= 256),
        n(o >= 1 && _ <= 512),
        n(o <= _),
        (c = c || 0),
        (d = d || 0));
      var u = 4 == t.BYTES_PER_ELEMENT ? t : new Uint32Array(t);
      return s(e.exports.meshopt_buildMeshletsFlex, u, r, r.length / a, 4 * a, i, o, _, c, d);
    },
    buildMeshletsSpatial(t, r, a, i, o, _, c) {
      (n(t.length % 3 == 0),
        n(r instanceof Float32Array),
        n(r.length % a == 0),
        n(a >= 3),
        n(i > 0 && i <= 256),
        n(o >= 1 && _ <= 512),
        n(o <= _),
        (c = c || 0));
      var d = 4 == t.BYTES_PER_ELEMENT ? t : new Uint32Array(t);
      return s(e.exports.meshopt_buildMeshletsSpatial, d, r, r.length / a, 4 * a, i, o, _, c);
    },
    extractMeshlet(e, t) {
      return (
        n(t >= 0 && t < e.meshletCount),
        ((e, t) => {
          var n = e.meshlets[4 * t + 0],
            r = e.meshlets[4 * t + 1],
            s = e.meshlets[4 * t + 3];
          return {
            vertices: e.vertices.subarray(n, n + e.meshlets[4 * t + 2]),
            triangles: e.triangles.subarray(r, r + 3 * s)
          };
        })(e, t)
      );
    },
    computeClusterBounds(t, s, i) {
      return (
        n(t.length % 3 == 0),
        n(t.length / 3 <= 512),
        n(s instanceof Float32Array),
        n(s.length % i == 0),
        n(i >= 3),
        ((t, n, s, i) => {
          var o = e.exports.sbrk,
            _ = o(48),
            c = o(t.byteLength),
            d = o(n.byteLength),
            u = new Uint8Array(e.exports.memory.buffer);
          (u.set(r(t), c),
            u.set(r(n), d),
            e.exports.meshopt_computeClusterBounds(_, c, t.length, d, s, i));
          var l = a(_);
          return (o(_ - o(0)), l);
        })(4 == t.BYTES_PER_ELEMENT ? t : new Uint32Array(t), s, s.length / i, 4 * i)
      );
    },
    computeMeshletBounds(t, s, i) {
      return (
        n(0 != t.meshletCount),
        n(s instanceof Float32Array),
        n(s.length % i == 0),
        n(i >= 3),
        ((t, n, s, i) => {
          var o = e.exports.sbrk,
            _ = [],
            c = o(n.byteLength),
            d = o(t.vertices.byteLength),
            u = o(t.triangles.byteLength),
            l = o(48),
            f = new Uint8Array(e.exports.memory.buffer);
          (f.set(r(n), c), f.set(r(t.vertices), d), f.set(r(t.triangles), u));
          for (var h = 0; h < t.meshletCount; ++h)
            (e.exports.meshopt_computeMeshletBounds(
              l,
              d + 4 * t.meshlets[4 * h + 0],
              u + t.meshlets[4 * h + 0 + 1],
              t.meshlets[4 * h + 0 + 3],
              c,
              s,
              i
            ),
              _.push(a(l)));
          return (o(c - o(0)), _);
        })(t, s, s.length / i, 4 * i)
      );
    },
    computeSphereBounds(t, s, i, o) {
      return (
        n(t instanceof Float32Array),
        n(t.length % s == 0),
        n(s >= 3),
        n(!i || i instanceof Float32Array),
        n(!i || i.length % o == 0),
        n(!i || o >= 1),
        n(!i || t.length / s == i.length / o),
        ((t, n, s, i, o) => {
          var _ = e.exports.sbrk,
            c = _(48),
            d = _(t.byteLength),
            u = i ? _(i.byteLength) : 0,
            l = new Uint8Array(e.exports.memory.buffer);
          (l.set(r(t), d),
            i && l.set(r(i), u),
            e.exports.meshopt_computeSphereBounds(c, d, n, s, u, i ? o : 0));
          var f = a(c);
          return (_(c - _(0)), f);
        })(t, t.length / s, 4 * s, i, 4 * (o = o || 0))
      );
    }
  };
})();
