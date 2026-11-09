'use strict';

(function (root) {
  const HEAVY_WORDS = [
    'connard','connards','connasse','con','conne','encule','enculer','encule toi','encul ton pere','enfoire','enfoires',
    'batard','batards','salope','salopes','pute','putes','putain','chienne','chiennes','fils de pute','fils de chienne',
    'ntm','fdp','tg','tgl','ftg','ntm ta mere','ntm sa mere','nique ta mere','nik ta mere','nike ta mere','nique ta daronne','nique ta race','nique tes morts','nique toi','nik ton pere','n tm','f d p',
    'ta mere','ta daronne','ta mere la pute','nik ta mere','ta gueule','ferme ta gueule','ferme ta gueule sale','ta gueule sale','ferme la','ta race','tes morts','va mourir','va te faire foutre','va te faire enculer','va te faire metttre',
    'suicide toi','va te suicider','va te pendre','pends toi','pend toi','pands toi','kys','k y s','kill yourself','hang yourself','go die','va crever','creve encul',
    'retard','retarded','mongol','mongolien','triso','trisomique','attarde','attarde mental','debile','debiles','débile','sous race','sous-race','sous race de merde',
    'ducon','tocard','bouffon','boloss','clochard','clown','merde','merdeux','cancer','cancer de merde','autiste','handicape','handicapé',
    'degage','dégage','casse toi','casse-toi','barre toi','pede','pd','pédé','tapette','tarlouze','tarlouzes','travelo','gouine',
    'ptn de bot','ce ptn','ce ptn de bot','wsh ptn','putain de bot','negro','negre','nigga','nigger','niggers','bougnoule','bicot','bamboula','youpin','feuj',
    'fuck you','fucking','motherfucker','bitch','whore','slut','fag','faggot','retard','trash human','garbage human','dogshit','dog shit','ez dog','trash dog','ez trash',
    'sale merde','sale pute','sale chienne','sale con','sale connard','sale enculé','sale batard','sale rat','sale chien','sale porc',

    // --- Audit faux negatifs (tests/fn-corpus.js) ---------------------------
    // Cibles ethniques et religieuses. C'etait le trou le plus grave : la regle
    // `sale\s*(merde|rat|chien|...)` n'enumerait que des insultes generiques, si
    // bien que « sale arabe » / « sale juif » traversaient tous les etages.
    'sale arabe','sale noir','sale noire','sale juif','sale juive','sale blanc',
    'sale rebeu','sale gitan','sale manouche','sale chinois','sale asiat',
    'sale russe','sale polonais','sale roumain','sale africain','sale immigre',
    'sale renoi','sale feuj','sale bougnoule','sale bicot','sale musulman',
    'chinetoque','chinetoques','niakoue','niakoues','bougnoul','sieg heil','heil hitler',
    // Insultes FR du registre « publiable » : absentes alors qu'elles sont la
    // premiere reformulation d'un chat qui veut eviter le filtre.
    'raclure','raclures','ordure','ordures','vermine','vermines','cassos',
    'pourriture','fumier','peigne cul','trou du cul','tete de noeud','tete de gland','face de rat',
    // Slurs homophobes derives : 'pd' et 'pede' etaient listes, pas ceux-ci.
    'pedale','pedales','fiotte','fiottes','lopette','lopettes','tarba','tarbas',
    // Validisme : la liste s'arretait a mongol/triso/autiste/handicape/debile.
    'mongolo','mongolos','trisomie','chromosome en trop','cas social','classe ulis',
    'schizo','malade mental','grand malade mental',
    // Misogynie : categorie entierement absente, regles ET prompt compris.
    'retourne a la cuisine','fais moi un sandwich','grosse thot','sale thot',
    'egirl','e girl','onlyfans quand',
    // Verlan : la forme droite etait bloquee, pas la verlanisee.
    'tepu','renoi','parasite du serveur',

    // --- Audit 2 (12 axes, ~540 messages mesures) ---------------------------
    // Fautes de frappe courantes : la variante fold() ne recupere que les lettres
    // DOUBLEES, jamais une lettre en moins ou substituee. Ce sont pourtant les
    // formes reelles du chat (conard, batar, geule, enkule). Le fuzzy (plus bas)
    // couvre le reste ; on liste ici les plus frequentes pour les avoir a cout nul.
    'conard','conards','conar','conars','conasse','conasses','batar','batars','batarde',
    'enkule','enkuler','enculay','salop','salops','geule','gueul','ta geule','ta gueul',
    'ferme ta geule','vos gueules','sallope','putin','vtff','ta reum','sa reum','nik sa reum',
    'nique sa reum','nique ta reum','nik ta reum','ta mere la chienne',
    // Argot / verlan / emprunts univoques (les polysemiques — miskine, wallah,
    // cheh, hess — sont en EXT_SUSP_RE : ils vont au modele, pas au mute sec).
    'teube','teubes','caillera','cailleras','bledard','bledards','gogol','gogols','crevard','crevards',
    'clodo','clodos','feignasse','feignasses','sans cervelle','nul a chier','nulle a chier','nuls a chier',
    'marde','dikkenek','cagole','cagoles','gros gitan','sale gitan','gitan de merde',
    // Derives suffixes : « boloss » / « bouffon » etaient bloques, pas leurs
    // formes flechies, qui contournaient heavyRes, SPACED_HEAVY_RE et SUSP_RE d un coup.
    'bolosse','bolosses','bolosser','bouffonne','bouffonnes','bouffonnerie','bouffonneries',
    // Anglais : les blocs menace / suicide / racisme n avaient ete ecrits qu en FR.
    'fk u','fku','fuk u','fck u','fuck u','fuk you','fck you','shut ur mouth','shut your mouth',
    'shut the f up','shut the fuck up','stfu','gtfo','eat shit','piece of shit','u suck','you suck',
    'get rekt','take the rope','grab the rope','off yourself','off urself','just end it','end yourself',
    'delete yourself','delete urself','wanker','wankers','twat','twats','dumbass','dumbasses','moron','morons',
    'incel','incels','have sex','seethe','dilate','i know where u live','i know where you live',
    'gonna dox','gonna doxx','go back to your country','go back to ur country','dogwater','braindead',
    'brain dead','shitter','shitters','dumb fuck','dumbfuck','cunt','cunts','cocksucker','cock sucker',
    'suck my','ching chong','chink','chinks','paki','pakis','kike','kikes','tranny','trannies','dyke','dykes',
    'fags','faggots','retards','autist','autists','sped','speds','bitch ass','fucking bot','fkin bot','fckin bot',
    // Misogynie / sexuel : la liste ne connaissait que 13 citations litterales.
    'onlyfans','only fans','thot','thots','t as tes regles','tas tes regles','t es hysterique','tes hysterique',
    'elle est bonne mais','elle est bonne donc','elle est bonne et','plus jolie que douee','quota fille',
    // Haine codee : chiffres et euphemismes canoniques, sans aucune lecture CS2.
    '14 88','88 88','les 14 mots','6mwe','卐','卍','francais de papier','pas le profil francais',
    'grand remplacement','valise ou cercueil','un charter pour toi','retourne dans ton bled','rentre dans ton bled',
    'allahu akbar','allah akbar','allah akbar quand','ca sent le kebab','sent le kebab','planquez vos portefeuilles',
    '109 pays','monsieur madame','voix de fille','langue de sauvage','langue de la jungle','langue de singe',
    'remigration','vole son rank comme','sale bledard','sale roumain','sale gitane','sale tzigane',
    // Menaces, doxx, brigading, suicide : les 5 verbes enumeres ne couvraient rien.
    'ruiner ta vie','frapper a ta porte','sonner chez toi','ta famille va payer','des potes dans ta ville',
    'on se croisera','tu me verras de pres','ta box va prendre cher','ton co va lag','coupure de wifi dans',
    'ta boite sera au courant','screen pour ton taf','mail a ton ecole','ton cpe','ton adresse traine',
    'je poste son numero','je poste ton numero','son vrai nom c est','son vrai nom cest','son vrai prenom c est',
    'son vrai prenom cest','mass report','report en masse','signale en masse','signalez le tous','signale le tous',
    'spam le report','raid discord','discord raid','fermer sa chaine','1 etoile partout','personne te regretterait',
    'fais nous plaisir a tous','des cordes chez toi','monde serait mieux sans','monde irait mieux sans',
    'personne remarquerait si tu','corde et un tabouret','je vais ruiner ta vie','arrive un truc a ta bagnole',
    // Triche : accusation directe et univoque (les insinuations restent en susp).
    'wallhack','wall hack','radar hack','hardware cheat','logiciel tiers','5 doigts magiques','config sus',
    'cheater confirmed','gros tricheur','grosse tricheuse','sale tricheur','il cheat','elle cheat','tu cheat',
    'tu cheates','il hack','elle hack','tu hack','wh pur','du wh','le wh','son wh','ton wh','coupe le wh',
    'enleve tes murs','ban incoming','refuse le handcam','handcam ou tu','elo boost','elo boosted','compte achete',
    'prime achete','rank achete','lvl 10 achete','lvl achete','spinbot','spin bot','triggerbot'
  ];
  const EXTRA_SPLIT = /[,;\n\r]+/;
  // `l` et `mid` en sont sortis : isoles ils sont anodins, mais ce sont les deux
  // tokens de moquerie les moins chers a spammer et CLEAN_RE les gardait SEC,
  // avant meme la file LLM. Ils partent desormais au modele, qui a le pile-on.
  // Emotes : l'ancien `:\\w+:` blanchissait TOUT code d'emote par sa forme
  // (:clueless:, :susge:, :ratio:) — le modele ne les voyait jamais. Seule une
  // liste nominative d'emotes anodines reste keep sec ; le reste part au modele.
  const EMOTE_OK = 'pog|pogchamp|poggers|pogu|pogo|kappa|lul|lulw|kekw|omegalul|pepega|sadge|madge|aware|catjam|monkas|pepehands|feelsbadman|feelsgoodman|pepelaugh|kekl|kekwait|hypers|widepeepohappy|peepohappy|dinkdonk|xdd|okayge|prayge|yep|nope|pepocheer|ezclap|gigachad|based|catkiss|pausechamp|monkahmm|noted|pepelove|elmofire|pogey|poggies|forsen|ayaya|peepoleave|peepoarrive|ratirl|heart|love|hype';
  const CLEAN_TOKEN = '(?:gg+|wp+|ggwp|glhf|hf|gl|n1|nice|rip+|f+|lol+|mdr+|ptdr+|xd+|ok+|oui|non|yes|no|w|a|b|ns|nt|gt|vp|mb|deso|sorry|site|eco|save|rotate|gg wp|' + EMOTE_OK + '|:(?:' + EMOTE_OK + '|gg|ez|wp|hf|gl):|\\^+)';
  // Queue : « ok... » / « lol... » sont du mepris par ponctuation ; un seul point.
  const CLEAN_RE = new RegExp('^(?:' + CLEAN_TOKEN + '!*\\.?\\s*)+$', 'i');

  const SPACED_HEAVY_RE =
    /(?:^|[^a-z])(ntm|fdp|tg|tgl|ftg|stfu|kys|pd|putain|tgueule|encule|connard|batard|salope|pute|merde|negro|nigga|nigger|tapette|tarlouze|mongol|autiste|handicape|triso|debile|tocard|bouffon|boloss|degage|casse toi|pede|fuckyou|motherfucker|dogshit|pendstoi|suicidetoi|tagueule|fermetagueule|niquetamere|filsdepute|tesmorts|tarace|ceptn|putaindebot)(?:$|[^a-z0-9])/i;

  const FALLBACK_HEAVY_RE =
    /(?:^|[^a-z])(ntm|fdp|wsh ptn|putain|stfu|kys|encule|enculer|salope|connard|batard|ta gueule|ferme ta gueule|nique ta|fils de pute|tes morts|ta race|va mourir|suicide toi|pende?s toi|tocard|bouffon|autiste|handicape|degage|casse toi|pede|pd|tapette|nigga|nigger|fuck you|motherfucker|dogshit|sale (merde|rat|con|pute|chienne)|gros (con|nul|merde)|ptn de bot|ce ptn|va crever|creve encul)(?:$|[^a-z])/i;

  const FALLBACK_HARSH_RE =
    // \b obligatoire : sans lui « jai ete nul » (auto-critique) matchait via le
    // « te nul » de « ete nul » et se faisait masquer comme une insulte.
    /\bt[ ']?es?\s+nul|tes une merde|t une merde|sale rat|sale merde|ez dog|dog ?shit|ferme (ta gueule|la)|va te niquer|nique toi|tu pues|pauvre type|sous.?race|kill ?your ?self|hang ?your ?self|go die|uninstall you|ez trash|trash team|gros nul|tes nul/i;

  const SUSP_RE = [
    /\bez\s*(dog|trash|noob|bot|clown|merde|nul|pute|encule|fils)\b/i,
    /\b(sale|gros)\s+(merde|rat|chien|con|pute|clown|porc|nul|batard|connard)\b/i,
    /\b(trash|dogshit|garbage)\b/i,
    /\b(ferme|nique|va crever|creve encul|pends|suicide|kys|tg|ntm|fdp|stfu|putain|ta mere|ta daronne)\b/i,
    /\b(autiste|handicape|triso|mongol|debile|attarde|boloss|bouffon|tocard|clochard|tapette|tarlouze|pede|pd|negro|nigga|nigger)\b/i
  ];
  const SUSP_NUL_RE = /\b(t es|tes|il est|elle est|ce joueur est|joueur nul|c est nul)\s*/i;

  // --- Correctifs issus de l'audit faux negatifs --------------------------
  // Ces motifs portent sur une TOURNURE, pas sur un terme isole : ils sont donc
  // testes sur suspLow/lowNfd et non ajoutes a HEAVY_WORDS, qui compare mot a
  // mot sur les variantes leet/collapsed.

  // Sans appel. Aucune lecture legitime de ces phrases dans un chat de match.
  const EXT_HEAVY_RE = new RegExp([
    // Suicide : la liste couvrait kys / pends toi / va crever, aucune periphrase.
    'prends?\\s+une\\s+corde', 'la\\s+corde\\s+(?:stp|svp)',
    'va\\s+te\\s+jeter', 'saute\\s+(?:par|du|de)\\s+(?:la\\s+fenetre|un\\s+pont)',
    'le\\s+monde\\s+irait\\s+mieux\\s+sans\\s+toi', 'tu\\s+vas\\s+disparaitre',
    'kill\\s*ur\\s*self', '\\bkms\\b', '\\bunalive\\b',
    'neck\\s*your\\s*self', 'rope\\s*(?:ur|your)\\s*self',
    // « creve » a l'imperatif uniquement : « je suis creve » est de la fatigue,
    // et c'est la forme la plus frequente du mot dans un chat.
    '(?<!\\b(?:suis|est|etait|es|chui|jsuis|trop|grave|tellement|vraiment|deja)\\s)\\bcreve\\b',
    // Menaces hors-jeu : rien ne les couvrait, et JUDGE_SYS ne dit que
    // « threat » au milieu d'une enumeration d'insultes.
    // « je vais te retrouver sur faceit / en game » est une promesse de match.
    'je\\s+vais\\s+te\\s+(?:retrouver|ddos|dox|defoncer|niquer\\s+irl)(?!\\s+(?:sur|en|dans)\\s+(?:faceit|mm|premier|ranked|game|la\\s+game|le\\s+serveur|le\\s+lobby|lobby|dm|le\\s+dm|discord|cs))',
    'je\\s+connais\\s+ton\\s+adresse', 'ton\\s+(?:adresse\\s+)?ip\\b',
    '\\bswat(?:ter|te|ting)?\\b', '\\bddos\\b', '\\bdoxx\\b',
    'attends\\s+moi\\s+a\\s+la\\s+sortie', 'ton\\s+employeur',
    'te\\s+faire\\s+perdre\\s+ton\\s+(?:taf|travail|boulot)',
    // Haine raciale : les phrases, le lexique est dans HEAVY_WORDS.
    'retourne\\s+dans\\s+ton\\s+pays', 'rentre\\s+chez\\s+toi',
    'chambre\\s+a\\s+gaz', '\\b1488\\b',
    // Misogynie et harcelement sexuel.
    '(?:les\\s+)?(?:filles|meufs|femmes)\\s+(?:savent|peuvent)\\s+pas\\s+jouer',
    'que\\s+pour\\s+l\\s*attention', 'pour\\s+son\\s+(?:decollete|cul|corps)',
    'montre\\s+tes\\s+(?:pieds|seins|nichons)', 'a\\s+du\\s+sucer',
    'boostee\\s+par\\s+son\\s+(?:mec|copain)', 'typique\\s+d\\s*une\\s+meuf',
    // Validisme par le QI / le cerveau.
    'qi\\s+(?:d\\s*une?\\s+\\w+|negatif|de\\s+\\d+)',
    'sans\\s+cerveau', '(?:a|as)\\s+pas\\s+de\\s+cerveau',
    // Troncatures et masquages par ponctuation. suspLow ayant deja remplace la
    // ponctuation par des espaces, « p-d » arrive ici en « p d » et « ta m*re »
    // en « ta m re » : les motifs colles ne pouvaient pas les voir.
    '\\bta\\s+g\\b', '\\bta\\s+m\\s*re\\b', '\\bp\\s+d\\b',
    'ferme\\s+ta\\s+bouche', 'putin\\s+de\\b',
    // --- Audit 2 ------------------------------------------------------------
    // Menaces : famille semantique ouverte au lieu de 5 verbes litteraux, et la
    // forme conditionnelle (« si je te croise »), qui est la forme reelle en chat.
    'je\\s+vais\\s+te\\s+(?:\\w+\\s+){0,2}(?:retrouver|ddos|dox|doxx|defoncer|niquer|casser|peter|frapper|buter|tuer|crever|ruiner|detruire|pourrir|trouver|fumer|demonter|eclater|choper)(?!\\s+(?:sur|en|dans)\\s+(?:faceit|mm|premier|ranked|game|la\\s+game|le\\s+serveur|le\\s+lobby|lobby|dm|le\\s+dm|discord|cs))',
    'si\\s+je\\s+te\\s+croise\\s+(?:irl|dehors|en\\s+vrai|un\\s+jour|a\\s+la\\s+lan)', 'jespere\\s+qu\\s*(?:il|elle)\\s+se\\s+fait\\s+(?:ecraser|renverser|tuer|buter)',
    '(?:le\\s+)?monde\\s+(?:serait|irait|sera|ira)\\s+mieux\\s+sans', 'y\\s+a\\s+des\\s+cordes\\s+chez\\s+toi', 'fais\\s+nous\\s+plaisir\\s+a\\s+tous',
    'personne\\s+(?:ne\\s+)?te\\s+regretterait', 'une\\s+corde\\s+et\\s+un\\s+tabouret', 'un\\s+conseil\\s+pour\\s+lui\\s+une\\s+corde',
    'i\\s+know\\s+where\\s+(?:u|you)\\s+live', 'go\\s+back\\s+to\\s+(?:your|ur)\\s+country', '(?:take|grab)\\s+the\\s+rope', 'shut\\s+(?:the\\s+)?(?:f|fuck|fk)\\s+up',
    '\\bdox(?:x|ed|xed|ing|xing)?\\s+(?:u|you|him|her|le|la)\\b', 'il\\s+habite\\s+a\\s+\\w+\\s+jsais', 'je\\s+poste\\s+son\\s+(?:numero|adresse)',
    // Brigading.
    'on\\s+le\\s+(?:signale|report)\\s+en\\s+masse', '(?:tout\\s+le\\s+monde|tous)\\s+sur\\s+son\\s+stream\\b', 'on\\s+lui\\s+fait\\s+fermer', 'on\\s+lui\\s+met\\s+1\\s+etoile',
    'raid\\s+(?:son|sa|le)\\s+(?:stream|chaine|discord)', 'signalez?\\s+le\\s+tous', 'spam\\s+le\\s+report',
    // « ta gueule » avec un adjectif glisse : « ta sale gueule », « ferme ta petite gueule ».
    '\\bta\\s+(?:\\w+\\s+){1,2}gueule\\b(?!\\s+de\\s+bois)', 'ferme\\s+(?:\\w+\\s+){1,3}gueule\\b',
    // Codes numeriques et symboles.
    '\\b(?:1488|14\\s*88|88\\s*88|6mwe|13\\s*52|les\\s+14\\s+mots)\\b',
    // Haine codee, formes fermees.
    'fait\\s+le\\s+ramadan\\s+c\\s*est\\s+pour\\s+ca', 'vient\\s+du\\s+93\\s+ca\\s+explique', 'regardez?\\s+son\\s+nom\\s+de\\s+famille\\s+et',
    'une\\s+communaute\\s+qui\\s+ruine', 'on\\s+sait\\s+tous\\s+d\\s*ou\\s+il\\s+vient', 'sont\\s+pas\\s+la\\s+pour\\s+jouer',
    // Misogynie et harcelement sexuel, formes fermees.
    'elle\\s+est\\s+bonne(?!\\s+(?:a|en|sur|pour|cette|la|ce|au|aux|dans|avec))', 'coupe\\s+la\\s+cam\\s+et\\s+on\\s+verra', '(?:finira|fini|finir)\\s+sur\\s+(?:mym|onlyfans|of)\\b',
    'en\\s+faisant\\s+du\\s+(?:onlyfans|mym)', 'va\\s+faire\\s+tes\\s+danses', 'faire\\s+des\\s+lives?\\s+makeup', 'juste\\s+pour\\s+le\\s+quota', 'signe\\s+pour\\s+son\\s+physique',
    'baisse\\s+(?:un\\s+peu\\s+)?la\\s+cam\\s+on\\s+verra', 'montre\\s+plutot\\s+autre\\s+chose', 'on\\s+sait\\s+tous\\s+pourquoi\\s+elle\\s+a\\s+(?:autant|tant)\\s+de\\s+viewers',
    // Triche, accusation directe.
    '(?:prime|lvl\\s*\\d+|compte|elo|rank|niveau)\\s+achete\\b', '(?<!anti\\s?)(?<!les\\s)(?<!des\\s)(?<!un\\s)\\baimbot\\b', '\\bhack\\s+a\\s+mort', 'cheat\\s+c\\s*est\\s+evident',
    'il\\s+a\\s+le\\s+wh\\b', 'stream\\s+avec\\s+le\\s+wh', '(?:petit\\s+)?soft\\s+qui\\s+va\\s+bien', 'sans\\s+son\\s+soft', 'il\\s+a\\s+le\\s+patch\\b', 'baisse\\s+ton\\s+aimbot',
    'demos?\\s+(?:sont\\s+)?privees?\\s+par\\s+hasard', 'boost\\s+par\\s+son\\s+pote', 'main\\s+de\\s+dieu\\s+ou\\s+un\\s+soft', 'legit\\s+ce\\s+mec\\s+bien\\s+sur', 'vac\\s+dans\\s+\\d+\\s+jours', 'ban\\s+dans\\s+\\d+\\s+jours',
    'achete\\s+son\\s+compte', 'chinois\\s+detecte',
    // Menaces voilees, formes fermees.
    'a\\s+\\d+\\s+min(?:utes)?\\s+de\\s+chez\\s+toi', 'pendant\\s+qu\\s*elle\\s+dure',
    // « on va se voir en vrai a la lan » est un rendez-vous, pas une menace.
    'on\\s+va\\s+se\\s+(?:voir|croiser)\\s+(?:en\\s+vrai|un\\s+jour|irl)(?!\\s+(?:a|au|aux|sur|pour)\\s+(?:la\\s+lan|lan|major|le\\s+major|paris|cologne|l\\s*event|la\\s+finale|l\\s*esl|blast|la\\s+pgl))',
    'chance\\s+d\\s*etre\\s+derriere\\s+ton\\s+ecran', 'tu\\s+sors\\s+(?:bien\\s+)?du\\s+(?:taf|boulot|travail|lycee|bahut)\\s+a\\s+\\d',
    'jespere\\s+que\\s+(?:ta|tes|ton)\\s+\\w+\\s+(?:va|vont)\\s+bien\\s+ce\\s+soir', 'arrive\\s+un\\s+truc\\s+a\\s+(?:tes|ta|ton)\\s+(?:gosses|enfants|famille|mere|soeur|frere|bagnole|voiture|maison|chat|chien|daronne)',
    'sa\\s+mere\\s+bosse\\s+a\\s+la\\s+mairie', 'sa\\s+mere\\s+bosse\\b.*\\b(?:jsais|je\\s+sais)\\b', 'son\\s+cv\\s+en\\s+pdf', 'fais\\s+gaffe\\s+en\\s+sortant', 'des\\s+potes\\s+(?:dans|a)\\s+ta\\s+ville', 'en\\s+terminale\\s+a\\s+\\w+\\s+cs2',
    // Misogynie, formes fermees.
    'mec\\s+derriere\\s+le\\s+clavier', '(?:copain|mec|duo)\\s+qui\\s+la\\s+(?:coach|boost|carry|porte)', 'sans\\s+son\\s+(?:duo|mec|copain)\\s+elle\\s+serait',
    'feminin\\s+c\\s*est\\s+(?:une\\s+blague|de\\s+la\\s+garderie|du\\s+bronze|nul|de\\s+la\\s+merde|une\\s+farce)', 'meufs\\s+dans\\s+les\\s+rosters?\\s+juste\\s+pour', 'demande\\s+a\\s+ton\\s+mec\\s+de',
    'stream\\s+pour\\s+les\\s+dons', 'on\\s+regarde\\s+pas\\s+pour\\s+ca', 'webcam\\s+est\\s+bien\\s+placee', 'le\\s+decor\\s+a\\s+regarder', 'c\\s*est\\s+les\\s+hormones',
    'toujours\\s+la\\s+victime\\s+avec\\s+les\\s+meufs', 'sale\\s+meuf\\b', '(?:il|elle|tu)\\s+suces?\\s+(?:des|les)\\s+(?:bites|queues)', 'suce\\s+des\\s+bites',
    // Haine codee, formes fermees.
    'un\\s+immigre\\s+qui', 'ton\\s+(?:dialecte|charabia|patois)', 'ne\\s+premature', 'certaines\\s+communautes', 'trop\\s+de\\s+diversite', 'qui\\s+possede\\s+les\\s+orgas',
    'toujours\\s+les\\s+memes\\s+derriere', 'le\\s+nez\\s+sur\\s+la\\s+cam', 'planter\\s+des\\s+bombes', 'pas\\s+de\\s+porc\\s+pour\\s+(?:lui|elle|eux)', 'plus\\s+chez\\s+nous\\s+(?:sur|dans|en|ici)',
    'ton\\s+accent\\s+me\\b', 'regardez?\\s+la\\s+machoire', 'avant\\s+c\\s*etait\\s+un\\s+mec', 'pomme\\s+d\\s*adam', 'parti\\s+chercher\\s+(?:le\\s+pain|les\\s+cigarettes|des\\s+clopes)',
    // Incitation au dogpile, forme ouverte.
    'tout\\s+le\\s+monde\\s+\\S+\\s+sur\\s+(?:lui|elle)\\b', 'on\\s+spam\\s+(?:nt|ns|l|ez|rip|f|gg|mid|ratio)\\b', 'des\\s+qu\\s*(?:il|elle)\\s+(?:rate|meurt|whiff)\\s+(?:on|tout\\s+le\\s+monde)\\b'
  ].join('|'), 'i');

  // Insulte claire mais registre plus leger : meme traitement que `harsh`.
  const EXT_HARSH_RE = new RegExp([
    // Vocabulaire d'insulte absent de HEAVY_WORDS.
    '\\b(?:abruti|abrutis|cretin|cretins|imbecile|imbeciles|idiot|idiots|' +
      'glandu|glandus|branleur|branleurs|nullard|nullards|guignol|guignols|' +
      'brele|breles|tanche|tanches|manchot|manchots|bouseux|lourdaud|larve|' +
      'nullite|bozo|bozos)\\b',
    // Bodyshaming et age.
    'gros\\s+lard', '\\bobese\\b', 'grosse\\s+baleine', '\\bpuceau\\b',
    'vierge\\s+a\\s+vie', '\\bnolife\\b',
    '(?<!\\b(?:je|jsuis|chui|suis|es|est)\\s)\\bno\\s*life\\b',
    't\\s*as\\s+12\\s+ans', 'retourne\\s+a\\s+l\\s*ecole', 'pue\\s+la\\s+solitude',
    // Trashtalk CS2 : le registre par defaut du chat de match, jamais couvert.
    // Le head est filtre pour ne pas mordre sur « la diff de score ».
    // Faux positifs corriges : « il a diff mais gg » / « il a bien diff » sont des
    // compliments ; la stop-list de tete ne contenait que des determinants.
    '\\b(?!(?:la|le|les|une|des|cette|quelle|grosse|petite|grande|aucune|a|ai|as|ont|avait|bien|trop|grave|vraiment|tres|si|tellement|pas|plus|meme|encore|deja|il|elle|ils|on|je|tu|nous|vous|fait|fais|font|est|sont|jamais|toujours|souvent|aussi|bon|beau|belle|de|du|en|sa|son|ma|mon|ta|ton|leur|notre|votre|quel|gros)\\b)\\w+\\s+diff\\b',
    // Jumeau de « X diff », jamais couvert : « awp andy », « prefire andy ».
    '\\b(?:awp|entry|spray|prefire|utility|util|bot|silver|bronze|nova|gold|deagle|scout|knife|eco|save|rush|camp|bait|kd|stat|padder|whiff|peek|lurk|angle|flash|nade|smoke|molly|wallbang|boost|hardstuck|choke|throw|feed|baiter|camper|noob|trash|nul|mm|premier|faceit|pray|sniper|shotgun|p90|mac10|tec9|deag|zeus)\\s+andy\\b',
    '\\bkd\\s+padder\\b', '\\bhard\\s+stuck\\b', '\\bfell\\s+off\\b', '\\bgoofy\\s+ahh?\\b', '\\bwho\\s+asked\\b', 'on\\s+t\\s*a\\s+rien\\s+demande',
    'skill\\s+issue', 'get\\s+good', '\\bgit\\s+gud\\b', '\\bcope\\b', '\\bcopium\\b',
    'stay\\s+mad', 'cry\\s+more', '\\bmald(?:ing)?\\b', 'touch\\s+grass',
    'toucher\\s+de\\s+l\\s*herbe', 'delete\\s+the\\s+game',
    // « il/elle » sortis du lookbehind : il blanchissait « on vote il desinstalle ».
    // « a/as/ont » ajoutes : « il a desinstalle le jeu » est une information.
    '(?<!\\b(?:jai|j\\s*ai|je|on|nous|a|as|ont|avait|avais|avons)\\s)desinstalle',
    // Trashtalk CS2 : roster, rang, materiel, changement de jeu.
    'bench\\s+le\\b', 'kick\\s+le\\s+(?:du\\s+roster|maintenant|direct|serieux)', 'sors\\s+le\\s+du\\s+roster', 'banc\\s+(?:direct\\s+)?pour\\s+lui',
    'renvoyer\\s+en\\s+academy', 'uninstall\\s+(?:le\\s+jeu|the\\s+game|cs|stp|maintenant|direct)', 'refund\\s+le\\s+jeu', 'remboursement\\s+pour\\s+ce\\s+stream',
    'retourne\\s+sur\\s+(?:fortnite|roblox|valorant|minecraft|lol|league|overwatch|cod|warzone|tiktok)', 'va\\s+(?:sur|streamer|jouer\\s+a)\\s+(?:valorant|fortnite|roblox|minecraft|overwatch|cod|warzone)\\b',
    'roblox\\s+t\\s*attend', 'vends\\s+ton\\s+pc', 'achete\\s+une\\s+console', 'deguise\\s+en\\s+pro', 'silver\\s*\\d?\\s+deguise', 'gamesense\\s+de\\s+(?:gold\\s+)?nova',
    'movement\\s+d\\s*un\\s+(?:gold\\s+)?nova', '\\b(?:nova|silver|bronze)\\s+moment\\b', 'lvl\\s*\\d\\s+(?:faceit\\s+)?(?:max|grand\\s+max)', 'lvl\\s*[1-5]\\s+grand\\s+max',
    'qui\\s+(?:rentre|hold|touche|frag|tue|clutch)\\s+jamais', 'squatte\\s+le\\s+roster', 'remplacez\\s+le\\s+par', 'nimporte\\s+quel\\s+lvl', 'sa\\s+carriere\\s+est\\s+derriere',
    'deja\\s+cuits?\\s+les\\s+reflexes', 'reflexes?\\s+de\\s+(?:mon\\s+)?grand\\s+pere', 'reaction\\s+de\\s+mon\\s+grand\\s+pere', 't\\s*es\\s+un\\s+dinosaure', 'reddit\\s+va\\s+adorer',
    'r\\s*globaloffensive', 'la\\s+meme\\s+sans\\s+lui', 'pour\\s+tenir\\s+la\\s+souris', 'pc\\s+de\\s+la\\s+mairie', '800\\s+dpi\\s+ca\\s+explique', 'candidate\\s+for\\s+the\\s+bench',
    'vieille\\s+(?:chevre|peau|bique|carne|branche)', 'grosse\\s+quiche', 'sac\\s+a\\s+pv\\b', 'nul\\s+a\\s+chier', 'joue\\s+sans\\s+cervelle',
    // Sarcasme a marqueur d'eloge + echec : voir SARCASM_HARSH_RE. Ici les
    // formes nominales d'insulte anglo (quel muppet, gros dumbass) via gros/quel.
    '\\b(?:quel|quelle|espece\\s+d|espece\\s+de|sale|gros|grosse|vrai|vraie|sacre|sacree)\\s+(?:muppet|wanker|twat|dumbass|moron|bum|npc|shitter|incel|loser|looser|plouc|beauf|mytho|forceur|chieur|chieuse|thon|boudin|cageot|bouffi|glandeur|glandeuse|feignant|feignante|nullos|deb|gogol|bledard|caillera|clodo|crevard|daube|feignasse|larve|tanche|brele|buse|cagole|dikkenek|bouffonne|conasse|conard|batar|salop)\\b',
    '\\bhardstuck\\b', '\\bboosted\\b', '\\bwashed\\b', 'no\\s+brain',
    // Mepris compare : le motif « ma grand mere vise mieux » etait trop
    // litteral, il ratait soeur / frere / aveugle / bot.
    '(?:ma|mon|sa|son|ta|ton)\\s+(?:(?:petit|petite|grand|grande|vieux|vieille)\\s+)?(?:soeur|frere|mere|pere|cousin|cousine|chien|chat|grand\\s*mere|grand\\s*pere|neveu|niece|fils|fille)\\s+' +
      '(?:\\w+\\s+){0,5}?(?:vise|joue|tire|ferait|viserait|jouerait|bouge|aim)\\s+mieux',
    'un\\s+aveugle\\s+(?:vise|joue|ferait|viserait)',
    'meme\\s+un\\s+(?:bot|silver|bronze|enfant|gamin|manchot|aveugle)\\s+(?:ferait|jouerait|viserait)',
    'un\\s+(?:silver|bronze|nova|gold|casu)\\s+ferait\\s+mieux',
    '(?<!\\b(?:je|jai|j\\s*ai|nous|on)\\s)joue\\s+avec\\s+(?:les|ses)\\s+(?:pieds|fesses|coudes)',
    '(?<!\\b(?:je|jai|j\\s*ai|nous|on)\\s)vise\\s+avec\\s+(?:les|ses)\\s+(?:fesses|coudes)',
    '(?:aucun|zero)\\s+(?:niveau|impact|aim|skill)', 'quel\\s+bot\\b',
    // Cible nommee : SUBJ n'enumere que des pronoms, donc « donk est fini »
    // passait quand « il est fini » mordait. Deux garde-fous obligatoires :
    // les possessifs (« mon aim est claque » = auto-derision) et la stop-list
    // de sujets non-humains — dont `est|sont`, sans quoi le groupe sujet
    // capture le verbe lui-meme et « le match est fini » se fait muter.
    '(?<!\\b(?:mon|ma|mes|notre|nos)\\s)' +
      '\\b(?!(?:je|jai|nous|on|est|sont|etait|etaient|reste|restent|sera|seront|' +
      'round|rounds|match|game|map|manche|partie|serie|stream|jour|annee|saison|' +
      'hltv|major|tournoi|highlight|clip|debat|sujet|histoire|periode|eco|timer|' +
      'bombe|aim|jeu|ping|fps|patch|meta|serveur|internet|souris|casque|micro)\\b)' +
      '[a-z0-9_]{3,16}\\s+(?:est\\s+|sont\\s+)?' +
      '(?:fini|finie|claque|claquee|surcote|surcotee|washed|overrated|choke|carried)\\b',
    // Incitation au dogpile : le seul registre a dommage collectif.
    'le\\s+report\\s+tous', 'raid\\s+son\\s+stream', 'lui\\s+pourrir\\s+ses',
    'unfollow\\s+tous', 'tout\\s+le\\s+monde\\s+spam',
    // --- Audit 2 : registre leger mais univoque ------------------------------
    'du\\s+talent\\s+pour\\s+(?:rater|perdre|whiff|feed|mourir|throw)', 'franchement\\s+du\\s+grand\\s+art', 'faut\\s+pas\\s+lui\\s+en\\s+vouloir\\s+il\\s+debute',
    'il\\s+fait\\s+ce\\s+qu\\s*il\\s+peut', 'son\\s+premier\\s+fps', 'bien\\s+sur\\s+c\\s*etait\\s+le\\s+lag', 'toujours\\s+la\\s+faute\\s+des\\s+(?:coequipiers|autres|mates|teammates)',
    'cheh\\s+bien\\s+fait', 'bien\\s+fait\\s+pour\\s+(?:sa|leur)\\s+gueule', '\\btebe\\b', 'zbeul\\s+de\\b', '\\b(?:le|un|ce)\\s+legume\\b', 'bouche\\s+trou', 'criss\\s+de\\s+(?:cave|con|tabarnak)',
    '(?:il|elle|ce\\s+(?:mec|keum|joueur|gars|type|bot|reuf|streamer))\\s+sert\\s+a\\s+rien', '(?:il|elle)\\s+touche\\s+rien\\b', '(?:il|elle|ce\\s+\\w+)\\s+sait\\s+(?:meme\\s+)?pas\\s+jouer',
    'tu\\s+fais\\s+honte', 'fait\\s+honte\\s+a\\s+la\\s+scene', 'arrete\\s+de\\s+jouer\\s*(?:serieux|stp|svp|frere|mec|$)', 'pue\\s+la\\s+(?:hess|misere|solitude|merde|defaite)',
    '(?:tarpin|trop|grave|tellement)\\s+nul\\s+(?:le|ce)\\s+(?:gars|mec|joueur|type)', '\\bun\\s+npc\\b', '\\bshut\\s+up\\b', '(?:il|elle|ce\\s+mec|ce\\s+joueur|tu)\\s+sucks?\\b',
    '\\b(?:cooked|bricked|clueless|dogwater|braindead|washed|shitter)\\s+ce\\s+(?:joueur|mec|gars|type|streamer)\\b', '\\bguez\\b',
    // Cible nommee + adjectif anglais (« donk est cooked ») : meme garde-fous que
    // la regle FR (possessifs, sujets non humains).
    '(?<!\\b(?:mon|ma|mes|notre|nos|on|je|jsuis|chui)\\s)' +
      '\\b(?!(?:je|jai|nous|on|est|sont|etait|etaient|reste|restent|sera|seront|' +
      'round|rounds|match|game|map|manche|partie|serie|stream|jour|annee|saison|' +
      'hltv|major|tournoi|highlight|clip|debat|sujet|histoire|periode|eco|timer|' +
      'bombe|aim|jeu|ping|fps|patch|meta|serveur|internet|souris|casque|micro|pc|setup|config|co|connexion|wifi)\\b)' +
      '[a-z0-9_]{2,16}\\s+(?:est|is|sont)\\s+(?:trop\\s+|grave\\s+|full\\s+|completement\\s+|tellement\\s+|so\\s+)?' +
      '(?:cooked|bricked|chalked|clueless|dogwater|braindead|dumb|garbage|dogshit|washed\\s+up|un\\s+bum|a\\s+bum|un\\s+npc|un\\s+shitter|un\\s+bot\\s+humain)\\b'
  ].join('|'), 'i');

  // Ambigu par construction : on ne peut pas trancher sans le contexte, donc on
  // route vers le modele (qui a ctx, pile-on et reputation d'auteur) au lieu de
  // muter sec. « ratio » est le cas d'ecole : c'est du dogpile en spam et une
  // stat legitime dans « il a un bon ratio ».
  // Chaque groupe porte un « hint » : la categorie remonte jusqu'au prompt du
  // modele (voir _suspHint). Les emoji seuls sont geres par emojiProfile().
  const EXT_SUSP_GROUPS = [
    { hint: 'spam', re: /\bratio\b|\bl\s+pour\s+(?:lui|elle|toi)\b|merite\s+un\s+l\b|^[a-z0-9_]{3,16}\s+l$|^l{4,}$|^z{5,}$|^(?:mdr|lol|xd|kekw|omegalul){3,}$/i },
    { hint: 'triche', re: new RegExp([
      '\\b(?:cheat|cheate|cheater|cheaters|triche|tricheur|tricheuse|aimbot|aim bot|vac ban|vacban|hack|hacks|hacker|hackeur)\\b',
      '\\bwh\\b', '\\bhandcam\\b', '\\bsoft\\b', '\\bboost(?:e|ed)?\\b', '\\bachete\\b',
      // Insinuations : pas de lexique, une forme. « comment il a vu ca », « y a un
      // truc la », « trop propre pour etre humain » — indecidables sans le clip.
      'a\\s+travers\\s+(?:le\\s+mur|les\\s+murs|la\\s+smoke|la\\s+porte|le\\s+sol)',
      'trop\\s+propre\\s+pour\\s+etre\\s+humain', 'snap\\s+tout\\s+seul', 'sans\\s+aide\\b',
      'souris\\s+a\\s+un\\s+cerveau', 'comment\\s+il\\s+a\\s+vu\\s+ca', 'comment\\s+elle\\s+a\\s+vu\\s+ca',
      'bizarre\\s+ce\\s+(?:flick|shot|tir|spray|preaim|pre\\s*fire)', 'y\\s+a\\s+un\\s+truc\\s+la',
      'preaim\\s+tout\\s+le\\s+monde', 'personne\\s+joue\\s+comme\\s+ca', 'ses\\s+demos?\\s+(?:sont\\s+)?privees?',
      'main\\s+de\\s+dieu\\s+ou', '100\\s+pour\\s+cent\\s+legit', 'legit\\s+bien\\s+sur', 'quel\\s+talent\\s+naturel',
      'signale\\s+sur\\s+faceit', 'ban\\s+dans\\s+\\d+\\s+jours', 'vac\\s+dans\\s+\\d+', 'chinois\\s+detecte'
    ].join('|'), 'i') },
    { hint: 'sarcasme', re: new RegExp([
      '\\b(?:respect|bravo|chapeau|merci|felicitations|gg)\\s+pour\\s+(?:avoir|ce|cette|le|la|ta|ton|sa|son)\\b',
      'impressionnant\\s+d\\s*etre', 'du\\s+talent\\s+pour', 'quel\\s+talent\\b', 'franchement\\s+du\\s+grand\\s+art',
      'standing\\s+ovation', 'clip\\s+ca\\b', '\\bclap\\s+clap\\b', 'masterclass\\b',
      'c\\s*est\\s+quoi\\s+ce\\s+(?:joueur|mec|stream|type|gars)', 'il\\s+fait\\s+quoi\\s+la', 'elle\\s+fait\\s+quoi\\s+la',
      'il\\s+debute\\b', 'il\\s+fait\\s+ce\\s+qu\\s*il\\s+peut', 'faut\\s+pas\\s+lui\\s+en\\s+vouloir',
      'joue\\s+depuis\\s+combien\\s+de\\s+temps', 'premier\\s+fps\\b', 'petit\\s+conseil\\b', 'y\\s+a\\s+des\\s+tutos',
      'no\\s+offense\\b', 'sans\\s+vouloir\\s+etre\\s+mechant', 'avec\\s+tout\\s+le\\s+respect', 'sans\\s+mechancete',
      'je\\s+dis\\s+ca\\s+(?:gentiment|sans)', 'au\\s+moins\\s+il\\s+a\\b', 'c\\s*est\\s+un\\s+progres',
      'bien\\s+sur\\s+c\\s*etait\\s+le\\s+lag', 'toujours\\s+la\\s+faute\\s+(?:des|du|de)\\b', 'bien\\s+sur\\b.*\\bbien\\s+sur\\b',
      'nice\\s+nice\\s+nice', 'gg\\s+le\\s+(?:whiff|throw|choke|miss)', 'bravo\\s+tu\\s+as\\s+reussi'
    ].join('|'), 'i') },
    { hint: 'sexuel', re: new RegExp([
      '\\b(?:mym|onlyfan|fansly|e\\s*girl|thot)\\b', 'elle\\s+est\\s+bonne\\b', 'la\\s+cam\\b.*\\b(?:baisse|descend|coupe|verra)',
      '(?:baisse|descends|coupe)\\b.*\\bla\\s+cam\\b', 'montre\\s+plutot', 'on\\s+sait\\s+tous\\s+pourquoi\\s+elle',
      'pourquoi\\s+elle\\s+a\\s+(?:autant|tant)\\s+de\\s+viewers', 'on\\s+regarde\\s+pas\\s+pour\\s+ca',
      'le\\s+decor\\s+a\\s+regarder', 'sans\\s+le\\s+filtre', 'elle\\s+a\\s+grossi', 'un\\s+mec\\s+derriere\\s+(?:le\\s+clavier|elle|la\\s+souris|la\\s+cam)',
      '(?:copain|mec|duo|pote)\\s+qui\\s+la\\s+(?:coach|boost|carry|porte)', 'sans\\s+son\\s+(?:duo|mec|copain|boost)\\s+elle',
      'cs\\s+feminin', 'tournois?\\s+feminins?\\s+c\\s*est', 'circuit\\s+feminin', 'pour\\s+son\\s+physique',
      'meufs?\\s+dans\\s+(?:les|le)\\s+rosters?', 'demande\\s+a\\s+ton\\s+mec', 'stream\\s+pour\\s+les\\s+dons',
      'webcam\\s+est\\s+bien\\s+placee', 'les\\s+hormones\\b', 'typique\\s+(?:elle|une\\s+meuf|les\\s+meufs)', 'la\\s+victime\\s+avec\\s+les\\s+meufs',
      'retourne\\s+sur\\s+(?:tiktok|insta|instagram|snap)', 'danses?\\s+sur\\s+tiktok', 'lives?\\s+makeup',
      'cs\\s+c\\s*est\\s+pas\\s+pour\\s+toi', 'vieille\\s+pour\\s+jouer', 'jolie\\s+que\\s+douee',
      // Pression de donateur : hors de tout modele de menace jusqu'ici.
      'jai\\s+(?:donne|depense|mis|lache)\\s+\\d+', 'tu\\s+me\\s+dois\\s+(?:bien\\s+)?un\\s+(?:mp|dm|merci|message|reponse)',
      'reponds\\s+a\\s+mes\\s+(?:mp|dm|messages)', 'accepte\\s+ma\\s+demande', 't\\s*as\\s+snap\\b', 'tu\\s+lis\\s+jamais\\s+mes\\s+(?:dm|mp)',
      'tu\\s+me\\s+calcules\\s+pas', 'vu\\s+ce\\s+que\\s+je\\s+donne', 'mis\\s+ce\\s+(?:top|decollete|haut|debardeur)\\s+expres', 'on\\s+sait\\s+tous\\s+pourquoi\\b',
      'pour\\s+ca\\s+qu\\s*elle\\s+a\\s+(?:autant|tant)\\s+de\\s+viewers', 'jsuis\\s+pas\\s+chelou', 'jattends\\s+depuis\\s+(?:hier|des\\s+jours|des\\s+semaines)'
    ].join('|'), 'i') },
    { hint: 'haine', re: new RegExp([
      'on\\s+sait\\s+tous\\s+d\\s*ou\\s+(?:il|elle)\\s+vient', 'certaines\\s+communautes', 'regardez?\\s+son\\s+nom\\s+de\\s+famille',
      'une\\s+communaute\\s+qui\\s+ruine', 'trop\\s+de\\s+diversite', 'qui\\s+possede\\s+les\\s+orgas', 'toujours\\s+les\\s+memes\\s+derriere',
      'le\\s+nez\\s+sur\\s+la\\s+cam', 'fait\\s+le\\s+ramadan', 'planter\\s+des\\s+bombes', 'pas\\s+de\\s+porc\\s+pour',
      'vient\\s+du\\s+93\\b', 'gens\\s+du\\s+voyage', 'plus\\s+chez\\s+nous', 'ton\\s+charabia', 'parle\\s+francais\\s+(?:steuplait|stp|svp|ici|merci|bordel)',
      'ton\\s+accent\\s+me', 'il\\s+est\\s+un\\s+peu\\b.*\\btu\\s+vois', 'sa\\s+voix\\s+trahit', 'aime\\s+les\\s+paillettes',
      'y\\s+a\\s+un\\s+truc\\s+entre', 'entre\\s+lui\\s+et\\s+son\\s+duo', 'regardez?\\s+la\\s+machoire', 'avant\\s+c\\s*etait\\s+un\\s+mec',
      'pomme\\s+d\\s*adam', 'de\\s+quelle\\s+origine\\b', 'ca\\s+explique\\s+tout\\b', 'genetiquement\\b', 'la\\s+pasteque\\b',
      '\\bde\\s+(?:sa|leur)\\s+race\\b', 'les\\s+gens\\s+comme\\s+toi', '\\bsale\\s+(?:etranger|etrangere|immigre|immigree|migrant|migrante|clandestin)\\b',
      '\\b(?:bougnoul|rebeu|renoi|feuj|beur|chintok|niak|bamboula|babtou|toubab|gaulois|gwer|blanc\\s+de\\s+merde|sale\\s+francais)\\b'
    ].join('|'), 'i') },
    { hint: 'menace', re: new RegExp([
      '(?:fais|fait|faites)\\s+gaffe\\s+(?:en\\s+sortant|a\\s+toi|dehors|ce\\s+soir|a\\s+ta)', 'on\\s+se\\s+croisera', 'on\\s+va\\s+se\\s+(?:voir|croiser)\\s+en\\s+vrai',
      'se\\s+voir\\s+en\\s+vrai\\s+toi\\s+et\\s+moi', 'a\\s+\\d+\\s+min\\s+de\\s+chez\\s+toi', 'pendant\\s+qu\\s*elle\\s+dure', 'derriere\\s+ton\\s+ecran',
      'frapper\\s+a\\s+ta\\s+porte', 'sonner\\s+chez\\s+toi', 'arrive\\s+un\\s+truc\\s+a\\s+(?:ta|tes|ton)\\b', 'tu\\s+sors\\s+(?:bien\\s+)?du\\s+taf\\s+a',
      'va\\s+lag\\s+bizarrement', 'ta\\s+box\\b', 'ton\\s+cpe\\b', 'ton\\s+ecole\\b', 'ton\\s+lycee\\b', 'ton\\s+taf\\b', 'ta\\s+boite\\b', 'ton\\s+patron\\b',
      'jespere\\s+que\\s+(?:ta|tes|ton)\\s+\\w+\\s+(?:va|vont)\\s+bien', 'tes\\s+gosses\\b', 'tes\\s+enfants\\b', 'si\\s+je\\s+te\\s+croise\\b',
      'tu\\s+vas\\s+comprendre\\b', 'jai\\s+des\\s+potes\\s+(?:dans|a)\\s+ta', 'jhabite\\s+(?:le\\s+meme|pas\\s+loin|a\\s+cote)', 'le\\s+meme\\s+quartier',
      'il\\s+habite\\s+a\\s+\\w+', 'elle\\s+habite\\s+a\\s+\\w+', 'son\\s+(?:vrai\\s+)?(?:nom|prenom|numero|adresse|lycee|ecole)\\s+(?:c\\s*est|est)\\b',
      'sa\\s+mere\\s+bosse', 'son\\s+cv\\b', 'cherchez\\s+\\w+\\s+\\w+\\s+cs2', 'tout\\s+le\\s+monde\\s+sur\\s+son\\s+stream', 'on\\s+lui\\s+(?:fait|pourrit|met)\\b',
      'jai\\s+(?:deux\\s+trois|des)\\s+trucs\\s+a\\s+lui\\s+envoyer', 'quelqu\\s*un\\s+a\\s+son\\s+discord', '\\bdox\\b', '\\bdoxed\\b', '\\bdoxing\\b',
      'y\\s+a\\s+des\\s+cordes', 'une\\s+corde\\b', 'un\\s+tabouret\\b', 'reviendrai[st]?\\s+pas', 'personne\\s+(?:te\\s+)?regretterait', 'jespere\\s+qu\\s*il\\s+se\\s+fait\\s+(?:ecraser|renverser|tuer)',
      'les\\s+bleus\\s+vont\\s+sonner', 'ta\\s+bagnole\\b', 'ta\\s+voiture\\b', 'on\\s+vote\\s+il\\s+desinstalle'
    ].join('|'), 'i') },
    { hint: 'argot', re: new RegExp([
      '\\b(?:miskine|miskina|zehef|starfoullah|hess|wallah|nchallah|inchallah|kho|khey|cheh|guez|guedin|sah)\\b',
      '\\b(?:reuf|keum|bledard|cave|dikkenek|tarpin|criss|tabarnak|marde)\\b', 'sac\\s+a\\s+pv', 'bouche\\s+trou', '\\bboulet\\b', '\\bnpc\\b',
      '\\b(?:deb|debs|fragile|fragiles|daube|feignasse|gogol|clodo|crevard|caillera|bouffonnerie)\\b', '\\bnul\\s+a\\s+chier\\b',
      '\\bbum\\b', '\\bcooked\\b', '\\bbricked\\b', '\\bchalked\\b', '\\bclueless\\b', '\\bdogwater\\b', '\\bfell\\s+off\\b', '\\bwho\\s+asked\\b',
      'on\\s+t\\s*a\\s+rien\\s+demande', '\\bandy\\b', '\\bgoofy\\s+ahh?\\b', '\\bsuck\\b', '\\bsucks\\b', '\\bdumb\\b', '\\brekt\\b', '\\bmuppet\\b',
      '\\bgros\\s+rate\\b', '\\bzbeul\\b', '\\bteube?\\b', '\\bcimer\\s+pour\\b', '\\bmid\\s+ce\\s+(?:mec|joueur|gars)\\b', '\\bpetit\\s+monde\\b.*\\bfais\\s+attention', 'son\\s+insta\\s+c\\s*est'
    ].join('|'), 'i') },
    { hint: 'code', re: /\b(?:14|18|88|109|1312|1352)\b\s*[!.]*$/ },
    // Hors-sujet politique : le modele juge (jamais mute local). Les termes
    // politiques et militants passent ici en hint=politique quelle que soit
    // l'orientation politique.
    { hint: 'politique', re: new RegExp([
      '\\b(?:macron|melenchon|melanchon|lfi|nfp|bardella|zemmour|le\\s*pen|marechal|ciotti|retailleau|reconquete|rassemblement\\s+national|trump|maga|poutine|putin)\\b',
      '\\b(?:le|du|au)\\s+rn\\b', '\\bvotez?\\s+rn\\b', 'vive\\s+le\\s+rn',
      'france\\s+insoumise',
      '\\b(?:palestine|gaza|cisjordanie|intifada|israel|hamas)\\b',
      '\\b(?:acab|acav|1312)\\b', 'all\\s+cops', 'from\\s+the\\s+river', 'defund\\s+the\\s+police',
      '\\b(?:facho|fachos|fasciste|fascistes|woke|wokisme|wokistes?)\\b',
      'extreme\\s+(?:droite|gauche)', 'privilege\\s+blanc',
      '\\b(?:decolonial|colonialisme|intersectionn?el)\\b',
      '\\b(?:islamophob\\w*|transphob\\w*)\\b',
      '(?:t\\s*es|tes|c\\s*est|le\\s+chat\\s+est|vous\\s+etes)\\s+racistes?',
      'je\\s+vote\\s+(?:lfi|nfp|ps|macron|rn|bardella|zemmour|le\\s*pen)', 'macron\\s+demission',
      'palestine\\s+libre', 'guerre\\s+en\\s+ukraine',
      '\\b(?:greve\\s+generale|reforme\\s+des\\s+retraites)\\b',
      'c\\s*est\\s+problematique', 'educate\\s+yourself', 'eduque\\s+toi'
    ].join('|'), 'i') },
    { hint: 'emoji', re: /[🤡🐒🐵🍌👎🤏💩🖕🦍🦧🍉🐷🐽👃🕌📍🔪🔫🚓🪦⚰🪑🥔👵👴🤖🥵💦👅🍑🍆🫵]/u }
  ];

  // Sarcasme univoque : un marqueur d'eloge ET un echec nomme dans la meme ligne.
  // « bravo pour le clutch » n'a pas d'echec ; « gg les gars on a perdu » n'est
  // pas vise (perdu/defaite volontairement absents : trop frequents en sincere).
  const PRAISE = '(?:bravo|gg|respect|chapeau|felicitations|merci|cimer|standing\\s+ovation|du\\s+grand\\s+art|quel\\s+talent|impressionnant|incroyable|excellent|magnifique|superbe|sublime|masterclass|specialiste|tres\\s+doue|applaudissements|clap\\s+clap)';
  const FAIL = '(?:whiff|whiffs|rate|rates|rater|throw|throws|ruine|ruiner|pire|honte|immobile|aussi\\s+(?:mal|mauvais|nul|nulle)|mourir\\s+en\\s+premier|premier\\s+mort|legende\\s+inversee|touche\\s+un\\s+mur|0\\s+kill|zero\\s+kill|choke|choker|feed|feeder|donner\\s+des\\s+infos)';
  const SARCASM_HARSH_RE = new RegExp([
    '(?<!\\b(?:je|jai|j\\s*ai|on|nous|moi)\\s)\\b' + PRAISE + '\\b(?:\\s+\\w+){0,6}?\\s+' + FAIL + '\\b',
    '\\b' + FAIL + '\\b(?:\\s+\\w+){0,4}?\\s+' + PRAISE + '\\b',
    // Comparaisons humiliantes et moqueries de progres.
    '(?:vise|joue|tire|bouge|aim|spray|peek)\\s+comme\\s+(?:mon|ma|un|une|ton|ta|sa|son)\\s+(?:petit\\s+|petite\\s+|grand\\s+|grande\\s+)?(?:cousin|cousine|frere|soeur|mere|pere|grand\\s*mere|grand\\s*pere|gamin|gamine|enfant|bebe|poisson\\s+rouge|manchot|aveugle|bot|silver|nova|debutant|handicape|legume|buse)',
    'on\\s+dirait\\s+(?:ma|mon|ta|ton)\\s+grand\\s*(?:mere|pere)', 'd\\s*un\\s+poisson\\s+rouge', 'de\\s+mon\\s+grand\\s+pere\\b',
    'courage\\s+petit\\b', 'mon\\s+grand\\s+tu\\s+feras\\s+mieux', 'on\\s+lui\\s+trouve\\s+une\\s+excuse', 'qui\\s+l\\s*a\\s+mis\\s+dans\\s+l\\s*equipe',
    'pourquoi\\s+il\\s+est\\s+titulaire', 'comment\\s+marche\\s+une\\s+souris', 'le\\s+clic\\s+gauche\\s+ca\\s+tire', 'la\\s+touche\\s+shift\\s+ca\\s+existe',
    'essaie\\s+de\\s+viser\\s+le\\s+personnage', 'specialiste\\s+du\\s+premier\\s+mort', 'doue\\s+pour\\s+(?:donner|mourir|rater|perdre|feed)',
    'personne\\s+peut\\s+faire\\s+pire', 'pourrais\\s+pas\\s+faire\\s+pire', 'et\\s+c\\s*est\\s+ca\\s+un\\s+(?:joueur\\s+)?pro', 'des\\s+gens\\s+qui\\s+payent\\s+pour\\s+voir\\s+ca',
    // « je trouve ca dur a regarder » est un avis ; sans 1re personne c'est du mepris.
    '(?<!\\b(?:je|perso|jsuis|moi|nous|on)\\b.{0,24})dur\\s+a\\s+regarder\\b', 'temps\\s+de\\s+raccrocher', 'reprendre\\s+le\\s+clavier', 'essayer\\s+un\\s+autre\\s+jeu', 'survecu\\s+\\d+\\s+secondes',
    'il\\s+a\\s+touche\\s+un\\s+mur', 'ca\\s+arrive\\b.*\\ba\\s+chaque\\s+round', 'la\\s+prochaine\\s+fois\\s+essaie\\s+de\\s+viser', 'regarde\\s+la\\s+minimap\\s+de\\s+temps\\s+en\\s+temps',
    'clip\\s+ca\\s+pour\\s+la\\s+posterite', 'ovation\\s+pour\\s+ce\\s+round', 'excellent\\s+placement\\s+pour\\s+mourir', 'jai\\s+vu\\s+des\\s+gens\\s+sur\\s+le\\s+tuto\\s+faire\\s+mieux',
    '(?:quelqu\\s*un|qui)\\s+(?:peut\\s+)?lui\\s+expli(?:que|quer)', 'il\\s+progresse\\s+il\\s+a\\b', 'le\\s+meme\\s+sens\\s+du\\s+jeu\\s+qu',
    'faire\\s+pire\\s+c\\s*est\\s+un\\s+record', 'merci\\s+d\\s*avoir\\s+ruine', 'respect\\s+pour\\s+avoir\\s+ose', 'chapeau\\s+pour\\s+le\\s+pire'
  ].join('|'), 'i');

  // Vitality CS2 roster 2026 — apEX, ZywOo, ropz, flameZ, mezii [+ coach XTQZZZ] — source HLTV / aboutgameworld 2026
  const VITALITY_ROSTER = ['zywoo','apex','ropz','flamez','mezii','vitality','vita','xtqzzz'];
  const VITALITY_RE = new RegExp('\\b(' + VITALITY_ROSTER.join('|') + ')\\b', 'i');
  const VITALITY_INSULT_RE = /\b(nul|nulle|nuls|claque|pourri|naze|bot|noob|trash|dog|washed|overrated|fraud|fake|overhyped|choke|choker|chokeur|chokeurs|useless|carried|carry|lucky|shit|dogshit|terrible|horrible|throw|troll|degueu|claqu[eé]|fini|mauvais|zero|nulard|merde|chienne|pute|connard|batard|salope|bouffon|tocard|clown|boloss|clochard|merdeux|fraude|surcot[eé]|gros|lourd|pue|puant|catastrophique|abuse|boosted|who|mid|retard|mongol|cancer|bait|baiter|bave|baver|baveux|chial|pleur|rageux|0 kills?|zero kills?|0 impact|tjrs 0|toujours 0|cooked|bricked|clueless|dogwater|braindead|npc|bum|shitter|fini|choke|choker)\b/i;

  // --- Repli d'ecriture ---------------------------------------------------
  // Caracteres de format invisibles (zero-width, soft hyphen, marques bidi) :
  // « co​rde » arrivait dans suspLow en « co rde » et aucun motif de phrase
  // ne le voyait plus. On les SUPPRIME (pas d'espace) avant toute autre vue.
  const ZW_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD\u180E\u061C]/g;
  const RLO_RE = /[\u202E\u202B\u2067]/;
  // Homoglyphes : NFKC ne replie que les blocs de compatibilite (pleine chasse,
  // math, cercles). Un « а » cyrillique, un « ο » grec ou un « ᴀ » petite capitale
  // survivaient a NFKC + NFD, puis etaient EFFACES par la vue stripped — le mot
  // sortait plus court et ne matchait plus rien. Une seule lettre substituee
  // desarmait toutes les listes a la fois. Table volontairement visuelle.
  const CONFUSABLES = {
    // cyrillique
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'к': 'k', 'і': 'i', 'ј': 'j',
    'ѕ': 's', 'һ': 'h', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'ѵ': 'v', 'т': 't', 'м': 'm', 'н': 'h', 'в': 'b',
    'г': 'r', 'п': 'n', 'д': 'd', 'б': 'b', 'з': 'e', 'ё': 'e', 'й': 'i', 'ц': 'u', 'ш': 'w', 'ь': 'b',
    'А': 'a', 'Е': 'e', 'О': 'o', 'Р': 'p', 'С': 'c', 'У': 'y', 'Х': 'x', 'К': 'k', 'І': 'i', 'Ј': 'j',
    'Ѕ': 's', 'Т': 't', 'М': 'm', 'Н': 'h', 'В': 'b', 'Г': 'r', 'Д': 'd', 'Б': 'b', 'З': 'e',
    // grec
    'α': 'a', 'ο': 'o', 'ν': 'v', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'ι': 'i', 'κ': 'k', 'χ': 'x', 'ε': 'e',
    'η': 'n', 'β': 'b', 'γ': 'y', 'μ': 'u', 'ς': 's', 'σ': 'o', 'ω': 'w', 'ζ': 'z', 'λ': 'l',
    'Α': 'a', 'Β': 'b', 'Ε': 'e', 'Ζ': 'z', 'Η': 'h', 'Ι': 'i', 'Κ': 'k', 'Μ': 'm', 'Ν': 'n', 'Ο': 'o',
    'Ρ': 'p', 'Τ': 't', 'Υ': 'y', 'Χ': 'x',
    // armenien, cherokee
    'օ': 'o', 'ա': 'a', 'ո': 'n', 'ս': 'u', 'ց': 'g', 'հ': 'h', 'ք': 'p', 'Ꭺ': 'a', 'Ꭰ': 'd', 'Ꮯ': 'c',
    'Ꮪ': 's', 'Ꮤ': 'w', 'Ꮶ': 'k', 'Ꭹ': 'y', 'Ꮟ': 'b', 'Ꭼ': 'e', 'Ꮐ': 'g', 'Ꮋ': 'h', 'Ꮠ': 'i', 'Ꭻ': 'j',
    'Ꮮ': 'l', 'Ꮇ': 'm', 'Ꮑ': 'n', 'Ꮎ': 'o', 'Ꮲ': 'p', 'Ꭱ': 'r', 'Ꮖ': 't', 'Ꮩ': 'v', 'Ꮓ': 'z', 'Ꮢ': 'r',
    // petites capitales (extensions phonetiques, hors NFKC)
    'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e', 'ꜰ': 'f', 'ɢ': 'g', 'ʜ': 'h', 'ɪ': 'i', 'ᴊ': 'j',
    'ᴋ': 'k', 'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n', 'ᴏ': 'o', 'ᴘ': 'p', 'ǫ': 'q', 'ʀ': 'r', 'ꜱ': 's', 'ᴛ': 't',
    'ᴜ': 'u', 'ᴠ': 'v', 'ᴡ': 'w', 'ʏ': 'y', 'ᴢ': 'z', 'ɐ': 'a', 'ɑ': 'a', 'ɓ': 'b', 'ɔ': 'c', 'ɗ': 'd',
    'ɖ': 'd', 'ǝ': 'e', 'ɟ': 'f', 'ɡ': 'g', 'ɥ': 'h', 'ɩ': 'i', 'ʞ': 'k', 'ɯ': 'w', 'ƞ': 'n', 'ɹ': 'r',
    'ʂ': 's', 'ʇ': 't', 'ʈ': 't', 'ʌ': 'v', 'ʎ': 'y', 'ʐ': 'z',
    // latin etendu sans decomposition
    'ø': 'o', 'Ø': 'o', 'ł': 'l', 'Ł': 'l', 'đ': 'd', 'Đ': 'd', 'ħ': 'h', 'Ħ': 'h', 'ı': 'i', 'ŋ': 'n',
    'Ŋ': 'n', 'ß': 'ss', 'æ': 'ae', 'Æ': 'ae', 'œ': 'oe', 'Œ': 'oe', 'ð': 'd', 'Ð': 'd', 'þ': 'p',
    'ƒ': 'f', 'ȷ': 'j', 'ĸ': 'k', 'ŧ': 't', 'Ŧ': 't', 'ƶ': 'z', 'ƀ': 'b', 'ɫ': 'l', 'ɬ': 'l'
  };
  const CONF_RE = new RegExp('[' + Object.keys(CONFUSABLES).join('') + ']', 'g');
  // Indicateurs regionaux (🇰🇾🇸) et lettres en carre negatif (🅱) : des lettres
  // dessinees, hors NFKC. Les drapeaux (🇫🇷) donnent « fr » : anodin.
  const REGIONAL_RE = /[\u{1F1E6}-\u{1F1FF}]/gu;
  const NEGSQ_RE = /[\u{1F170}-\u{1F189}]/gu;

  function foldScript(s) {
    let t = String(s || '');
    if (!t) return t;
    t = t.replace(ZW_RE, '');
    t = t.replace(CONF_RE, (c) => CONFUSABLES[c] || c);
    t = t.replace(REGIONAL_RE, (c) => String.fromCharCode(c.codePointAt(0) - 0x1f1e6 + 97));
    t = t.replace(NEGSQ_RE, (c) => String.fromCharCode(c.codePointAt(0) - 0x1f170 + 97));
    return t;
  }

  // Message ecrit a l'envers derriere une marque bidi (‮drannoc‬) : l'ecran
  // l'affiche a l'endroit, le DOM le stocke inverse. On ajoute la lecture inversee
  // en fin de message ; le mot droit y redevient visible pour toutes les listes.
  function unbidi(raw, folded) {
    if (!RLO_RE.test(raw)) return folded;
    return folded + ' ' + Array.from(folded).reverse().join('');
  }

  function normalize(text) {
    return foldScript(String(text || '')
      // NFKC replie les variantes de compatibilite Unicode : exposants (ᴺᵀᴹ),
      // pleine chasse (ＮＴＭ), cercles (ⓝⓣⓜ), math bold (𝐧𝐭𝐦). Sans lui elles
      // traversaient TOUTES les regles alors que « ntm » etait bloque. NFD seul
      // ne les touche pas : il ne depile que les diacritiques.
      .normalize('NFKC'))
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[@4]/g, 'a')
      .replace(/\$/g, 's')
      .replace(/0/g, 'o')
      .replace(/1(?=[a-z])/gi, 'i')
      .replace(/!/g, 'i')
      .replace(/\|/g, 'i')
      .replace(/3/g, 'e')
      .replace(/5/g, 's')
      .replace(/6/g, 'b')
      .replace(/7/g, 't')
      .replace(/8/g, 'b')
      .replace(/9/g, 'g')
      .replace(/\+/g, 't');
  }

  // --- Rage bait compétition : briques réutilisées par les motifs "harsh". ---
  // Intensifieur glissé entre « est » et l'adjectif. Sans lui, « il est nul »
  // matchait mais « il est TROP nul » passait — or c'est la forme la plus
  // courante du rage bait en chat de match.
  const INTENS =
    '(?:tres|trop|si|tellement|vraiment|franchement|completement|totalement|' +
    'carrement|juste|grave|hyper|ultra|super|deja|encore|toujours|bien|plutot|' +
    'assez|un\\s+peu|beaucoup|le\\s+plus|tarpin|de\\s+ouf|full|sacrement|archi)';
  // Sujet visé : 3e personne UNIQUEMENT. « je suis nul » / « jai ete nul » sont
  // de l'auto-dérision et doivent rester propres — c'est exactement le cas que
  // JUDGE_DEEP_SYS demande au modèle lent de blanchir avec le contexte.
  const SUBJ =
    // « on » retire : « on est nul / on est cuit / on est cooked », c'est la
    // team que le viewer soutient, pas une cible.
    '(?:il|elle|ils|elles|lui|ce\\s+mec|ce\\s+gars|ce\\s+type|ce\\s+joueur|' +
    'le\\s+joueur|cette\\s+joueuse|la\\s+joueuse|ce\\s+stream|le\\s+stream|' +
    'le\\s+streamer|ce\\s+streamer|la\\s+streameuse|le\\s+mec|le\\s+gars|' +
    'ce\\s+bot|ce\\s+clown)';
  // Adjectifs négatifs seulement : « il est trop fort » doit rester propre.
  const NEGADJ =
    '(?:nul|nulle|nuls|nulles|nulos|nullissime|mauvais|mauvaise|claque|claques|' +
    'pourri|pourrie|naze|nazes|fini|finie|ridicule|ridicules|minable|pathetique|' +
    'lamentable|catastrophique|degueu|guez|bot|bots|noob|trash|dog|mediocre|' +
    'faible|surcote|surcotee|overrated|washed|fraud|inutile|useless|' +
    // Anglais de joueur (audit 2) et registre FR nominal : « il est deb ».
    'cooked|bricked|chalked|clueless|dogwater|braindead|dumb|garbage|npc|shitter|bum|dinosaure|nullite|daube|' +
    'deb|gogol|cassos|boulet|boosted|toxic|toxique|honteux|honteuse|pitoyable|affligeant|genant|cringe|degueulasse|pourrie)';

  // Rage bait « sujet + est + intensifieur + adjectif ». Isole du reste des
  // motifs harsh parce que c est le seul groupe qui doit ceder devant une
  // nuance explicite : « il est nul ce round mais bon » critique une manche,
  // pas un joueur, et doit repartir en simple suspicion (donc audite par le
  // modele) plutot que d etre masque sec par le backstop mots-cles.
  const RAGE_PAT = [
    SUBJ + '\\s+(?:est|sont|etait|etaient|reste|restent)\\s+(?:' + INTENS + '\\s+)*(?:une?\\s+)?' + NEGADJ,
    'c\\s*(?:\\u0027)?\\s*est\\s+(?:' + INTENS + '\\s+)*(?:une?\\s+)?' + NEGADJ
  ];
  // Marqueurs de nuance. Volontairement court : un troll qui colle « mais bon »
  // retombe en suspicion, pas en blanc-seing.
  const MITIG_RE = /\b(mais bon|ca arrive|c est le jeu|pas grave|ce round|cette manche|ce match|cette map|comme map|comme carte|ce mode|le serveur|les serveurs|le ping|le lag|le format|le patch|sans manquer de respect|gg quand meme)\b|(?:ce|le)\s+stream\s+(?:est|etait)\s+(?:fini|finie|termine|terminee)/i;

  let heavyRes = null;
  let heavyResFolded = null;
  let heavyJoinedRe = null;
  let harshRes = null;
  let harshResStrict = null;

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  }

  function fold(s) {
    return String(s || '').replace(/(.)\1+/g, '$1');
  }

  function rebuild() {
    const pat = HEAVY_WORDS.map(escapeRe).join('|');
    heavyRes = new RegExp('(^|[^a-z])(' + pat + ')($|[^a-z])', 'i');
    const foldedWords = [];
    const seenFold = new Set();
    for (const w of HEAVY_WORDS) {
      const f = fold(w);
      if (f && !seenFold.has(f)) {
        seenFold.add(f);
        foldedWords.push(f);
      }
    }
    heavyResFolded = new RegExp('(^|[^a-z])(' + foldedWords.map(escapeRe).join('|') + ')($|[^a-z])', 'i');
    // Locutions multi-mots recollees, >= 8 lettres : cherchees sans frontiere
    // (voir _hitHeavy). En dessous de 8, « tarace » / « salecon » deviendraient
    // des sous-chaines plausibles de mots sains.
    // Exclus : recolles, ils sont des sous-chaines plausibles (« il a casse, toi… »).
    const JOINED_SKIP = new Set(['cassetoi', 'barretoi', 'tesmorts', 'vamourir', 'fermela']);
    const joined = [];
    for (const w of HEAVY_WORDS) {
      if (w.indexOf(' ') < 0) continue;
      const j = w.replace(/[^a-z0-9]/g, '');
      if (j.length >= 8 && /^[a-z0-9]+$/.test(j) && !JOINED_SKIP.has(j)) joined.push(j);
    }
    heavyJoinedRe = joined.length ? new RegExp('(?:' + joined.join('|') + ')', 'i') : null;
    const harshList = [
      't[ \\.\'\\-_]*es?\\s*(nul|nulle|nuls|claque|pourri|fini|mauvais|zero|nulos|naze|clown|bot|noob|trash|dog|chien|bouffon|tocard|boloss|clochard|merde|guez|claque au sol)',
      // « il est / ils sont / c'est » + N intensifieurs + adjectif négatif.
      // Avant : l'adjectif devait être collé à « est », donc « il est TROP nul »
      // passait entre les mailles alors que « il est nul » était bien attrapé.
      RAGE_PAT[0],
      RAGE_PAT[1],
      // Moquerie de niveau : le rage bait propre au chat de compétition.
      'niveau\\s+(?:silver|argent|bronze|nova|fer|casu|gold)\\s+(?:ce|ces|cet|cette|le|la|les|il|elle|ils|lui|eux)',
      'niveau\\s+d\\s*(?:\\u0027)?\\s*un\\s+(?:fce|faceit|lvl|level|niveau|silver|nova)\\s*\\d*',
      '(?<!\\b(?:je|jai|j ai|nous|on)\\s)joue\\s+comme\\s+(?:un|une|des)\\s*(?:bronze|silver|argent|gold|nova|manche|manches|pied|pieds|merde|bot|bots|noob|debutant|enfant|gamin|casu|sac|bum|npc|legume|buse|poisson|handicape|mongol|bledard|clodo|clochard|aveugle|manchot|grand\\s+mere|grand\\s+pere|larve|tanche|quiche|pute|p u t e|chevre)',
      '(?<!\\b(?:je|jai|j ai|nous|on)\\s)jouent\\s+comme\\s+des\\s+(?:manches|pieds|merdes|bots|guignols|casu|branques)',
      '(?<!\\b(?:je|jai|j ai|nous|on)\\s)vise\\s+avec\\s+(?:les|ses|son)\\s+(?:pieds|pied|cul|coudes)',
      '(?:ma|sa|ta)\\s+grand\\s*mere\\s+(?:vise|joue|tire)\\s+mieux',
      '(?:meme\\s+)?moi\\s+je\\s+(?:joue|vise|tire)\\s+mieux',
      'je\\s+(?:joue|vise|tire)\\s+mieux\\s+que\\s+(?:lui|elle|eux|ce)',
      'merite\\s+pas\\s+d\\s*\\u0027?\\s*etre\\s+(?:la|ici|pro)',
      '(?:a|ont)\\s+rien\\s+a\\s+(?:faire|foutre)\\s+(?:la|ici|en\\s+\\w+)',
      'devrait\\s+(?:arreter|desinstaller|changer\\s+de\\s+jeu|prendre\\s+sa\\s+retraite|se\\s+reconvertir)',
      'retourne(?:z|r)?\\s+(?:sur|a|en|au)\\s+(?:faceit|silver|bronze|mm|matchmaking|lvl|casu)',
      'equipe\\s+de\\s+(?:branques|bras\\s*casses|manches|guignols|clowns|bots|nazes|merde|pipe|tocards|bouffons)',
      'c\\s*est\\s+de\\s+la\\s+merde',
      'tes\\s+une?\\s*merde',
      't\\s*une?\\s*merde',
      'sale\\s*(merde|rat|chien|pute|con|connard|encule|batard|clown|trash|noob|porc|chienne|gros|nul)',
      'gros\\s*(nul|noob|bot|merde|con|degueu|porc|tas|bola|bouffon|tocard|boulet|fragile|lourdaud|bouseux|dumbass|bledard|crevard|clodo|gogol|naze|nullos|incel|shitter|bum|npc|debile|cassos|beauf|puceau|nolife|no life|thon|cageot|boudin|feignant|feignasse|branleur|glandeur|bouffi|mytho|forceur|chieur|batard|connard|fdp|pd|pede|encule|rageux|toxic|troll|baiteur|loser|looser|abruti|cretin|idiot|imbecile|guignol|bozo|moron|twat|wanker|muppet|clown|rat)',
      'grosse\\s*(merde|pute|salope|daube|quiche|larve|feignasse|bouffonne|conne|connasse|chienne|thot|baleine|vache|truie|bouse|nullite|tanche|brele|buse|dinde|pouffiasse|pouf|pouffe|tepu|grognasse|morue|conasse|cagole)',
      'ptn(\\s+de\\s+(bot|merde|chien|noob|trash|clown))',
      'ce\\s+ptn(\\s+de\\s+\\w+)?',
      'putain\\s*(de\\s*)?(bot|merde|chien|noob)',
      'ez\\s*(dog|trash|noob|bot|clown|merde|nul|fils|pute|cat|kids|team)',
      'easy\\s*(dog|trash|noob|bot)',
      'trash\\s*(team|player|dog|can|kid|talk)',
      'dog\\s*shit',
      'dogshit',
      'ferme\\s*(ta\\s*gueule|la|ton\\s*clapet|tg)',
      'va\\s*te\\s*(faire|nique|pendre|suicider|faire\\s*foutre)',
      'va\\s*(mourir|crever|nicher|chier|dormir)',
      'nique\\s*toi',
      'tu\\s*(pues|sers?a\\s*rien|sert\\s*a\\s*rien|es\\s*merde|es\\s*nul|es\\s*qu.*merde|es\\s*claqu)',
      'pauvre\\s*(type|merde|con|clown|noob|tas|chose)',
      'sous[\\s\\-]*race',
      'kill\\s*your\\s*self',
      'hang\\s*your\\s*self',
      'go\\s*die',
      'uninstall\\s*(you|pls|please|noob|trash)',
      'kys',
      'stfu',
      'st\\s*fu',
      'diff\\s*retard',
      'reported',
      'cancer\\s*(team|player|comms)?',
      'throw\\s*(dog|trash|noob)',
      'bot\\s*lobby',
      'get\\s*carried'
    ];
    harshRes = new RegExp('(?:^|[^a-z])(' + harshList.join('|') + ')(?:$|[^a-z])', 'i');
    // Variante sans le rage bait : servie quand le message porte une nuance.
    const rageSet = new Set(RAGE_PAT);
    harshResStrict = new RegExp('(?:^|[^a-z])(' +
      harshList.filter((p) => !rageSet.has(p)).join('|') + ')(?:$|[^a-z])', 'i');
  }

  function plainMessage(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(?:répond(?:s|re)?\s+à|replying\s+to)\s+@?[^\s:]+\s*:\s*/i, '')
      .trim();
  }

  // --- Vue \u00ab recollee \u00bb -----------------------------------------------------
  // Les vues stripped/noSpace recollent bien \u00ab p u t e \u00bb, mais elles effacent
  // AUSSI les espaces entre les mots : \u00ab il joue comme une p u t e serieux \u00bb
  // devient un seul bloc de lettres ou plus aucune frontiere (^|[^a-z]) n'existe.
  // Un mot anodin avant et apres l'insulte espacee suffisait a tout desarmer.
  // `despaced` recolle uniquement (1) les separateurs entre deux lettres
  // (c.o.n.n.a.r.d, p_u_t_e, p*ute), (2) les emoji infixes (salo\ud83d\ude02pe) et (3) les
  // suites d'au moins trois lettres isolees (p u t e), en GARDANT les espaces
  // entre les vrais mots. Les listes y retrouvent leurs frontieres.
  const PICTO_RE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\ufe0f\u200d]/gu;
  const INFIX_SEP_RE = /(?<=[a-z])[.\-_*+~^`'"#@%$]+(?=[a-z])/g;
  const SPACED_RUN_RE = /(?<![a-z0-9])(?:[a-z0-9] ){2,}[a-z0-9](?![a-z0-9])/g;

  function despace(lowNfd) {
    return lowNfd
      .replace(PICTO_RE, '')
      .replace(INFIX_SEP_RE, '')
      .replace(/\s+/g, ' ')
      .replace(SPACED_RUN_RE, (m) => m.replace(/ /g, ''))
      .trim();
  }

  // --- Fuzzy : fautes volontaires ------------------------------------------
  // fold() ne recupere que les lettres doublees. Les vraies fautes du chat sont
  // des lettres en MOINS ou SUBSTITUEES (conard, geule, enkule, salop) et une
  // etoile qui remplace une lettre (enc*le, s*lope). Distance de Damerau-
  // Levenshtein <= 1, premiere lettre identique, jeton >= 5 lettres, lexique
  // restreint aux insultes de >= 6 lettres dont aucun voisin a distance 1 n'est
  // un mot francais courant. Les voisins connus sont explicitement exclus.
  const FUZZY_LEX = [
    'connard', 'connasse', 'encule', 'enculer', 'enfoire', 'batard', 'salope', 'putain', 'tapette',
    'tarlouze', 'bougnoule', 'nigger', 'mongol', 'tocard', 'bouffon', 'boloss', 'clochard', 'gueule',
    'faggot', 'motherfucker', 'trisomique', 'connards', 'salopes', 'batards', 'encules'
  ];
  const FUZZY_STOP = new Set([
    'bavard', 'bavarde', 'bavards', 'connais', 'connait', 'connaisse', 'connaissent', 'connaisses',
    'galope', 'galoper', 'artiste', 'canard', 'bazar', 'tocade', 'gueuler', 'gueulait', 'gueulent',
    'mongole', 'mongolie', 'mongolz', 'bouffe', 'bouffer', 'bouffes', 'salon', 'salons', 'putois', 'encore',
    'enclume', 'enfouir', 'enfoui', 'clocher', 'clochers', 'nigeria', 'bigger', 'mother', 'tapote',
    'tapoter', 'boulot', 'bolide', 'salade', 'salades', 'batarde', 'guerre'
  ]);
  const FUZZY_SET = new Set(FUZZY_LEX);

  function damerau1(a, b) {
    // Vrai ssi distance de Damerau-Levenshtein <= 1 (une insertion, suppression,
    // substitution ou transposition). Test direct, sans matrice.
    if (a === b) return true;
    const la = a.length;
    const lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    let i = 0;
    while (i < la && i < lb && a[i] === b[i]) i++;
    if (i === la || i === lb) return true; // suffixe manquant
    if (la === lb) {
      // substitution
      if (a.slice(i + 1) === b.slice(i + 1)) return true;
      // transposition
      return i + 1 < la && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
    }
    if (la > lb) return a.slice(i + 1) === b.slice(i); // suppression
    return b.slice(i + 1) === a.slice(i); // insertion
  }

  function fuzzToken(tok) {
    if (tok.length < 5 || tok.length > 12 || FUZZY_SET.has(tok) || FUZZY_STOP.has(tok)) return tok;
    if (!/^[a-z]+$/.test(tok)) return tok;
    for (const w of FUZZY_LEX) {
      if (w[0] === tok[0] && damerau1(tok, w)) return w;
    }
    return tok;
  }

  // \u00ab pu**in \u00bb : les etoiles remplacent des lettres, le nombre d'etoiles donne
  // le nombre de lettres cachees (a une pres).
  function unstar(tok) {
    const m = /^([a-z]{1,4})\*{1,3}([a-z]{1,5})$/.exec(tok);
    if (!m) return tok;
    const re = new RegExp('^' + m[1] + '.{1,3}' + m[2] + '$');
    for (const w of FUZZY_LEX) if (re.test(w)) return w;
    for (const w of HEAVY_WORDS) if (w.length >= 4 && w.indexOf(' ') < 0 && re.test(w)) return w;
    return tok;
  }

  function fuzzView(lowNfd, despaced) {
    // Jetons etoiles depuis lowNfd (despace() a deja mange les etoiles), fautes
    // depuis despaced. Borne : 40 jetons, au-dela on ne fuzz plus (pave).
    const flat = lowNfd.replace(/\s+/g, ' ').trim();
    const stars = flat.indexOf('*') >= 0 ? flat.split(' ').map(unstar).join(' ') : '';
    const toks = despaced.split(' ');
    let changed = false;
    const out = toks.length > 40 ? toks : toks.map((t) => {
      const f = fuzzToken(t);
      if (f !== t) changed = true;
      return f;
    });
    let v = changed ? out.join(' ') : '';
    if (stars && stars !== flat) v = (v ? v + ' ' : '') + stars.replace(/[^a-z0-9\s]/g, ' ');
    return v;
  }

  function buildCtx(text) {
    const raw = String(text || '');
    // Toutes les vues derivent de la forme NFKC repliee (foldScript), pas de
    // `raw` : lowNfd/suspLow alimentent les motifs de phrase et se faisaient
    // contourner par les memes homoglyphes et zero-width que normalize() ignorait.
    const uni = unbidi(raw, foldScript(raw.normalize('NFKC')));
    const plain = plainMessage(uni);
    const norm = normalize(uni);
    const stripped = norm.replace(/[^a-z0-9]/g, '');
    const collapsed = norm.replace(/(.)\1{1,}/g, '$1');
    const collapsedStripped = collapsed.replace(/[^a-z0-9]/g, '');
    const lowNfd = uni.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const noSpace = lowNfd.replace(/[^a-z0-9]/g, '');
    const foldLow = fold(lowNfd);
    const suspLow = lowNfd.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const despaced = despace(lowNfd);
    const despacedLeet = despaced === lowNfd.replace(/\s+/g, ' ').trim() ? '' : normalize(despaced);
    const fuzzed = fuzzView(lowNfd, despaced);
    return {
      raw, plain, norm, stripped, collapsed, collapsedStripped, lowNfd, noSpace, foldLow, suspLow,
      despaced, despacedLeet, fuzzed
    };
  }

  function ctxVariants(ctx) {
    const v = [ctx.norm, ctx.stripped, ctx.collapsed, ctx.collapsedStripped, ctx.noSpace, ctx.despaced];
    if (ctx.despacedLeet) v.push(ctx.despacedLeet);
    if (ctx.fuzzed) v.push(ctx.fuzzed);
    return v;
  }

  // Vues \u00ab phrase \u00bb : les motifs EXT_* et SUSP ne voyaient que suspLow, donc
  // jamais une insulte recollee ni une faute corrigee.
  function phraseViews(ctx) {
    const v = [ctx.suspLow];
    if (ctx.despaced && ctx.despaced !== ctx.suspLow) v.push(ctx.despaced);
    if (ctx.fuzzed) v.push(ctx.fuzzed);
    return v;
  }

  function _hitHeavy(ctx) {
    for (const v of ctxVariants(ctx)) {
      if (!v) continue;
      const padded = ' ' + v + ' ';
      if (heavyRes.test(padded)) return true;
      if (SPACED_HEAVY_RE.test(padded)) return true;
    }
    if (heavyResFolded.test(' ' + ctx.collapsed + ' ')) return true;
    if (heavyResFolded.test(' ' + ctx.foldLow + ' ')) return true;
    // Locutions recollees (>= 8 lettres) cherchees SANS frontiere dans la vue
    // sans espaces : « mais v a t e f a i r e f o u t r e » ne contient aucune
    // frontiere exploitable, mais « vatefairefoutre » n'est la sous-chaine
    // d'aucun mot francais.
    if (heavyJoinedRe && (heavyJoinedRe.test(ctx.noSpace) || heavyJoinedRe.test(ctx.collapsedStripped))) return true;
    for (const v of phraseViews(ctx)) if (EXT_HEAVY_RE.test(v)) return true;
    if (EXT_HEAVY_RE.test(ctx.lowNfd)) return true;
    return FALLBACK_HEAVY_RE.test(ctx.lowNfd);
  }

  function _hitHarsh(ctx) {
    // Nuance explicite : on ne garde que les insultes franches et on laisse le
    // rage bait redescendre en suspicion, pour que ce soit le modele qui tranche.
    const re = MITIG_RE.test(ctx.suspLow) ? harshResStrict : harshRes;
    for (const v of ctxVariants(ctx)) {
      if (v && re.test(' ' + v + ' ')) return true;
    }
    for (const v of phraseViews(ctx)) if (EXT_HARSH_RE.test(v)) return true;
    if (SARCASM_HARSH_RE.test(ctx.suspLow)) return true;
    if (emojiProfile(ctx.plain, true)) return true;
    if (repetitionProfile(ctx.plain).hard) return true;
    if (/gueule\s+de\s+bois/.test(ctx.suspLow)) return false;
    return FALLBACK_HARSH_RE.test(ctx.lowNfd);
  }

  // --- Emoji seuls -----------------------------------------------------------
  // L'ancienne regle gardait sec TOUT message emoji de moins de 6 unites UTF-16
  // sauf 7 pictos codes en dur : 🖕, 🦍, 🍉, 📍, 🔪, 🥵 n'etaient JAMAIS juges, et
  // la forme la plus courte (💀💀) etait la mieux protegee. On raisonne desormais
  // par ensembles : moquerie/haine → suspicion (le modele a le pile-on),
  // ambigu (💀😭👏) → le modele sans suspicion, anodin → keep sec.
  const EMOJI_HARSH = new Set(['🖕']);
  const EMOJI_MOCK = new Set(Array.from(
    '🤡🐒🐵🍌👎🤏💩🦍🦧🍉🐷🐽🐖👃🕌📍🔪🔫🚓🪦⚰🪑🥔👵👴🤖🥵💦👅🍑🍆🤮🤢🗑🚮♿🦽🧏🫵🐀🐁🪳🧟👺👹🥴🤥🪦'
  ));
  const EMOJI_AMBIG = new Set(Array.from('💀😴🥱🤦👏😭🤣😂🙄😐😑🫠🥲😬😪🤨🧐👀'));
  const EMOJI_JOIN_RE = /[\p{Emoji_Modifier}\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;
  const EMOJI_PICTO_RE = /\p{Extended_Pictographic}/gu;

  // Renvoie null si le message contient autre chose que des emoji, sinon un
  // profil { count, maxRep, harsh, mock, ambig }. harshOnly=true : booleen court.
  function emojiProfile(plain, harshOnly) {
    const t = String(plain || '');
    if (!t || !/\p{Extended_Pictographic}/u.test(t)) return harshOnly ? false : null;
    const rest = t.replace(EMOJI_JOIN_RE, '').replace(EMOJI_PICTO_RE, '').replace(/[\s!?.…,]/g, '');
    if (rest) return harshOnly ? false : null;
    const pictos = Array.from(t.replace(EMOJI_JOIN_RE, '').matchAll(EMOJI_PICTO_RE)).map((m) => m[0]);
    let harsh = false;
    let mock = false;
    let ambig = false;
    const counts = new Map();
    let maxRep = 0;
    for (const p of pictos) {
      if (EMOJI_HARSH.has(p)) harsh = true;
      else if (EMOJI_MOCK.has(p)) mock = true;
      else if (EMOJI_AMBIG.has(p)) ambig = true;
      const c = (counts.get(p) || 0) + 1;
      counts.set(p, c);
      if (c > maxRep) maxRep = c;
    }
    // Trois fois le meme picto de moquerie (🤡🤡🤡) : plus d'ambiguite, mute local.
    if (harshOnly) return harsh || (mock && maxRep >= 3);
    return { count: pictos.length, maxRep, harsh, mock, ambig };
  }

  // Jetons dont la REPETITION est le signal : un « L » passe, « L L L L » est un
  // dogpile. Les jetons anodins repetes (gg gg gg gg) vont au modele sans
  // suspicion : ils ne doivent pas etre mutes sur une panne d'API.
  const MOCK_TOKEN_RE = /^(?:l|mid|ratio|ez|nt|ns|rip|f|kekw|omegalul|lulw|lul|icant|clueless|susge|copium|hopium|cope|bozo|zzz+|💀|🤡|👏|🐒|🍌|👎|🫵)$/i;

  function repetitionProfile(plain) {
    const toks = String(plain || '').toLowerCase().replace(/:(\w+):/g, '$1').split(/\s+/).filter(Boolean);
    if (toks.length < 3) return { spam: false, mock: false };
    const counts = new Map();
    let maxTok = '';
    let maxRep = 0;
    for (const t of toks) {
      const c = (counts.get(t) || 0) + 1;
      counts.set(t, c);
      if (c > maxRep) {
        maxRep = c;
        maxTok = t;
      }
    }
    const spam = maxRep >= 3 || (toks.length >= 5 && counts.size <= 2);
    const mock = maxRep >= 3 && MOCK_TOKEN_RE.test(maxTok);
    // Quatre fois le meme jeton de moquerie (L L L L, nt nt nt nt) : mute local.
    const hard = maxRep >= 4 && MOCK_TOKEN_RE.test(maxTok);
    return { spam, mock, hard };
  }

  // --- Copypasta -----------------------------------------------------------
  // Un pave copie-colle ne se juge pas sur ses mots : il peut etre parfaitement
  // poli et rester du bruit qui noie le chat. On le reconnait a sa FORME. Les
  // formes ci-dessous se mesurent sur UN message ; le meme pave reposte par
  // plusieurs auteurs demande une memoire et vit dans content.js.
  //
  // Ce qui n'est PAS une pasta : un avis long, deux phrases courtes identiques,
  // un begaiement (c est c est), les mots-outils FR/EN qui reviennent. La
  // longueur seule a ete retiree — c'etait la source n°1 de faux positifs
  // (msgText tronquait a 300, donc tout pavé tombait pile sur le seuil).
  const ART_RE = /[\u{2190}-\u{21FF}\u{2500}-\u{25FF}\u{2800}-\u{28FF}\u{2B00}-\u{2BFF}]/gu;
  // Polices decoratives : cercles/carres, pleine chasse, maths alphanumeriques.
  const FANCY_RE = /[\u{2460}-\u{24FF}\u{FF01}-\u{FF5E}\u{1D400}-\u{1D7FF}]/gu;
  const LETTER_RE = /[a-z\u{00C0}-\u{024F}]/giu;
  const PASTA_STOP = new Set(
    ('a au aux avec c ca ce ces cet cette d de des du elle en et est il ils je l la le les lui ma mais me mes moi mon n ne nos notre nous on ou par pas pour qu que qui s sa se ses son sur t ta te tes toi ton tu un une vos votre vous y wp gg the of to is it in that you for on are was be this').split(' ')
  );

  function repeatedNgram(toks, n) {
    if (toks.length < n * 2) return false;
    const seen = new Map();
    for (let i = 0; i + n <= toks.length; i++) {
      const slice = toks.slice(i, i + n);
      // 1-2 jetons distincts = begaiement / martelement, pas une phrase recopiee.
      if (new Set(slice).size < 3) continue;
      const g = slice.join(' ');
      const prev = seen.get(g);
      if (prev !== undefined && i >= prev + n) return true;
      if (prev === undefined) seen.set(g, i);
    }
    return false;
  }

  function copypasta(plain) {
    const t = String(plain || '');
    if (t.length < 25) return '';
    const letters = (t.match(LETTER_RE) || []).length;

    // 1. Dessin : barres, blocs, braille, fleches — et presque aucune lettre.
    const art = (t.match(ART_RE) || []).length;
    if (art >= 12 && art >= letters) return 'ascii art';

    // 2. Police decorative : la signature visuelle du pave recopie.
    const fancy = (t.match(FANCY_RE) || []).length;
    if (t.length >= 40 && fancy >= t.length * 0.5) return 'police deco';

    // 3. Segment identique repete DANS le message. 24 car. pour ecarter
    //    « c etait trop beau. c etait trop beau. » tape a la main.
    const segs = t
      .toLowerCase()
      .split(/[.!?\u{2026}\n]+|\s{3,}/u)
      .map((s) => s.trim())
      .filter((s) => s.length >= 24);
    const seen = new Set();
    for (const s of segs) {
      if (seen.has(s)) return 'pave repete';
      seen.add(s);
    }

    const toks = t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

    // 3b. Meme phrase recollée sans ponctuation (« xyz xyz »).
    if (repeatedNgram(toks, 5)) return 'pave repete';

    // 4. Martelement : 8× n'importe quel jeton, ou 6× un mot de contenu.
    //    Les mots-outils ne comptent pas dans le ratio — un paragraphe FR
    //    répète « de/le/que » sans être un collage.
    if (toks.length >= 12) {
      const counts = new Map();
      let maxRep = 0;
      let maxTok = '';
      for (const k of toks) {
        const c = (counts.get(k) || 0) + 1;
        counts.set(k, c);
        if (c > maxRep) {
          maxRep = c;
          maxTok = k;
        }
      }
      const contentHammer = maxRep >= 6 && maxTok.length >= 3 && !PASTA_STOP.has(maxTok);
      if (maxRep >= 8 || contentHammer) return 'martelement';
      const content = toks.filter((k) => k.length >= 3 && !PASTA_STOP.has(k));
      if (content.length >= 10) {
        const uniq = new Set(content);
        if (uniq.size <= content.length * 0.25) return 'martelement';
      }
    }
    return '';
  }

  // Codes numeriques de la haine. « 88 » seul ou « 14 » seul restent ambigus
  // (score, hp) → suspicion ; les combinaisons sont dans HEAVY_WORDS.
  const HATE_CODE_RE = /^\s*(?:14|18|88|109|1312|1352|13\s*52)\s*[!.]*\s*$/;

  // Motif → categorie. La categorie (« hint ») remonte jusqu'au prompt du modele
  // pour qu'il sache QUEL angle regarder : c'est ce qui manquait sur la triche,
  // le sarcasme et le harcelement sexuel, indistinguables d'un chat ordinaire
  // pour un juge qui recoit la ligne nue.
  function _suspHint(ctx) {
    const low = ctx.suspLow;
    const views = phraseViews(ctx);
    if (low) {
      for (const re of SUSP_RE) if (re.test(low)) return 'insulte';
      if (SUSP_NUL_RE.test(low) && /nul/i.test(low)) return 'insulte';
      for (const g of EXT_SUSP_GROUPS) {
        for (const v of views) if (g.re.test(v)) return g.hint;
        if (g.re.test(ctx.plain)) return g.hint;
      }
    }
    if (HATE_CODE_RE.test(ctx.plain)) return 'code';
    // Emoji ambigu repete AVEC du texte : « lui 💀💀💀 », « tout le monde 💀 sur lui ».
    if (/(?:[💀😂🤣😭👏🫥]\s*){3,}/u.test(ctx.plain)) return 'emoji';
    const em = emojiProfile(ctx.plain, false);
    if (em && (em.mock || em.harsh)) return 'emoji';
    if (em && em.ambig && em.maxRep >= 3) return 'emoji';
    const rep = repetitionProfile(ctx.plain);
    if (rep.mock) return 'spam';
    return '';
  }

  function _isSuspicious(ctx) {
    return !!_suspHint(ctx);
  }

  function _hitVitalityHate(ctx) {
    const hay = ctx.lowNfd + ' ' + ctx.suspLow + ' ' + ctx.norm + ' ' + ctx.noSpace + ' ' + ctx.foldLow + ' ' + ctx.collapsed;
    if (!VITALITY_RE.test(hay)) return false;
    // Neutral praise should not flag — need negative signal
    if (VITALITY_INSULT_RE.test(hay)) return true;
    if (VITALITY_INSULT_RE.test(ctx.foldLow)) return true;
    // Fallback: any generic toxic already detected near roster name. Seule la
    // suspicion d'INSULTE compte : un marqueur de sarcasme (« masterclass de
    // apex ») ou de spam ne fait pas d'un eloge une attaque.
    if (_hitHeavy(ctx) || _hitHarsh(ctx) || _suspHint(ctx) === 'insulte') return true;
    return false;
  }

  function _isBrainrot67(ctx) {
    let t = ctx.plain
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
      .replace(/[^\w\s'-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!t) return false;
    t = t
      .replace(/^(?:mdr+|ptdr+|lol+|lmao+|xd+|haha+|ahi+|wsh+|ptn+|omg+|tf+)\s+/g, '')
      .replace(/\s+(?:mdr+|ptdr+|lol+|lmao+|xd+|haha+)$/g, '')
      .trim();
    const token =
      '(?:6[\\s\\-_.]*7|six[\\s\\-]*seven|s+i+x+\\s*s+e+v+e+n+s*|s+i+x+\\s*s+e+p+t+s*|doot[\\s\\-]*doot|67[\\s]*kid|soixante[\\s\\-]*sept)';
    const whole = new RegExp('^(?:' + token + ')(?:\\s+' + token + ')*[!?]*$', 'i');
    if (whole.test(t)) return true;
    if (/^(?:6[\s\-_.]*7[\s,!]*){2,}$/.test(t)) return true;
    if (/^(?:six[\s\-]*se(?:ven|pt)[\s,!]*){2,}$/i.test(t)) return true;
    const m = t.match(/6\s*7|six\s*seven/gi);
    if (m && m.length >= 2 && t.length < 40) return true;
    return false;
  }

  function _isTrivial(ctx) {
    const t = ctx.plain;
    // Etait `< 2`, ce qui gardait sec tout message d'un seul caractere — dont
    // « L », la moquerie la moins chere du chat. Les mono-caracteres vraiment
    // anodins (w, f, ?) restent couverts par CLEAN_TOKEN ou la regle ponctuation.
    if (!t) return true;
    if (/^[:;8xX][-']?[)(DPpoO]+$/.test(t)) return true;
    if (/^<3+$/.test(t)) return true;
    if (/^[!?.…\s]+$/.test(t)) return true;
    // Chiffres seuls : score, hp, vote. L'ancien test \p{Emoji} attrapait AUSSI
    // les chiffres ASCII (bases des keycaps) : « 14 », « 88 », « 109 », « 1312 »
    // etaient keep sec, tout le catalogue des codes numeriques de la haine.
    if (HATE_CODE_RE.test(t)) return false;
    if (/^[\d\s.,:\-+/]+$/.test(t)) return true;
    // Emoji seuls : voir emojiProfile(). Moquerie, haine, ambigu → juge.
    const em = emojiProfile(t, false);
    if (!em) return false;
    if (em.harsh || em.mock || em.ambig) return false;
    return em.count <= 3;
  }

  function _isCleanFast(ctx) {
    if (!ctx.plain) return true;
    // Repetition : CLEAN_RE acceptait « gg » et « gg gg gg gg gg » a l'identique,
    // alors que la repetition d'un jeton anodin apres une mort EST la moquerie.
    // Un jeton repete >= 4 fois (ou 6 jetons pour <= 2 distincts) part au modele.
    if (!CLEAN_RE.test(ctx.plain)) return false;
    return !repetitionProfile(ctx.plain).spam;
  }

  function _matchExtra(text, words) {
    if (!words || !words.length) return '';
    const ctx = buildCtx(text);
    const joined = ctxVariants(ctx).join(' ');
    const rawLow = ctx.raw.toLowerCase();
    for (const w of words) {
      // includes() faisait de « con » un mute de « contre », « raconte », « second ».
      if (w.length < 3) continue;
      const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(^|[^a-z0-9])' + esc + '([^a-z0-9]|$)', 'i');
      if (re.test(joined) || re.test(rawLow)) return w;
    }
    return '';
  }

  rebuild();

  // Cache LRU: le chat Twitch répète les mêmes spams en boucle (67, gg, ez...).
  // analyze() coûte ~6 passes regex + normalize → sans cache on le paie 2x par
  // message (content.js + background.js). Hit = ~O(1).
  const ANALYZE_CACHE = new Map();
  const ANALYZE_CACHE_MAX = 2000;

  // Citation : « il a dit ntm au micro » rapporte l'insulte d'un tiers. Le mot
  // lourd mutait sec dans content.js et la ligne n'atteignait jamais l'etage
  // deep qui a pourtant l'instruction de blanchir la citation. On degrade en
  // suspicion : le modele tranche, et une panne d'API mute quand meme (cut <= .6).
  const QUOTE_RE = /\b(?:il|elle|le mec|le gars|le type|le joueur|le streamer|la streameuse|quelqu ?un|un mec|un gars|le chat|il m|elle m|ils m|on m)\s+(?:m\s*)?(?:a|ont|vient de|viennent de)\s+(?:dit|ecrit|sorti|lache|balance|mis|repondu|tape|envoye)\b/;
  // Negation d'accusation : « il cheat pas » defend, n'accuse pas.
  const NEG_CHEAT_RE = /\b(?:cheat|cheate|hack|triche)\s+(?:pas|jamais)\b/;

  function analyzeUncached(text) {
    const ctx = buildCtx(text);
    let heavy = _hitHeavy(ctx);
    let harsh = _hitHarsh(ctx);
    let hint = _suspHint(ctx);
    if (heavy || harsh) {
      if (/gueule\s+de\s+bois/.test(ctx.suspLow)) {
        heavy = false;
        harsh = false;
      } else if (QUOTE_RE.test(ctx.suspLow)) {
        heavy = false;
        harsh = false;
        hint = 'citation';
      } else if (NEG_CHEAT_RE.test(ctx.suspLow)) {
        heavy = false;
        harsh = false;
        hint = 'triche';
      }
    }
    return {
      heavy,
      harsh,
      susp: !!hint,
      hint,
      brainrot: _isBrainrot67(ctx),
      trivial: _isTrivial(ctx),
      clean: _isCleanFast(ctx),
      vitalityHate: _hitVitalityHate(ctx)
    };
  }

  function analyzeCached(text) {
    const raw = String(text || '');
    if (!raw) return { heavy: false, harsh: false, susp: false, hint: '', brainrot: false, trivial: true, clean: true, vitalityHate: false };
    // Messages longs quasi-uniques (pavés) : pas de cache, ça polluerait la Map.
    if (raw.length > 220) return analyzeUncached(raw);
    const hit = ANALYZE_CACHE.get(raw);
    if (hit) {
      ANALYZE_CACHE.delete(raw);
      ANALYZE_CACHE.set(raw, hit);
      return hit;
    }
    const res = analyzeUncached(raw);
    ANALYZE_CACHE.set(raw, res);
    if (ANALYZE_CACHE.size > ANALYZE_CACHE_MAX) {
      const first = ANALYZE_CACHE.keys().next().value;
      ANALYZE_CACHE.delete(first);
    }
    return res;
  }

  root.CSG_KEYWORDS = {
    normalize,
    plainMessage,
    buildCtx,
    copypasta,

    hitHeavy(text) {
      return _hitHeavy(buildCtx(text));
    },

    hitHarsh(text) {
      return _hitHarsh(buildCtx(text));
    },

    isSuspicious(text) {
      return _isSuspicious(buildCtx(text));
    },

    isBrainrot67(text) {
      return _isBrainrot67(buildCtx(text));
    },

    isTrivial(text) {
      return _isTrivial(buildCtx(text));
    },

    isCleanFast(text) {
      return _isCleanFast(buildCtx(text));
    },

    analyze(text) {
      return analyzeCached(text);
    },

    cacheStats() {
      return { size: ANALYZE_CACHE.size, max: ANALYZE_CACHE_MAX };
    },

    hitVitalityHate(text) {
      return _hitVitalityHate(buildCtx(text));
    },

    // Categorie de suspicion ('' si aucune) : remonte dans le prompt du modele.
    suspHint(text) {
      return _suspHint(buildCtx(text));
    },

    foldScript,

    parseExtra(raw) {
      return String(raw || '')
        .split(EXTRA_SPLIT)
        .map((w) => w.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 200);
    },

    hitExtra(text, words) {
      return !!_matchExtra(text, words);
    },

    // Renvoie LE terme qui a mordu, pas un booleen : la boucle de retour de la
    // liste apprise a besoin de savoir lequel accuser quand l'utilisateur
    // revele le message.
    matchExtra(text, words) {
      return _matchExtra(text, words);
    }
  };
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : globalThis);
