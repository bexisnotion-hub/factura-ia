const RULES = [
  // Categorías médicas (prioritarias)
  { category: 'Suministros Médicos', keywords: ['guantes', 'jeringas', 'gasas', 'algodón', 'algodón', 'catéter', 'cateter', 'espéculo', 'especulo', 'agujas', 'jeringa', 'vendas', 'sutura', 'bisturí', 'bisturi', 'desechable', 'material médico', 'material medico', 'suministros médicos', 'farmacéutico', 'farmaceutico', 'instrumental', 'quirúrgico', 'quirurgico', 'sonda', 'tubo', 'mascarilla', 'bata médica'] },
  { category: 'Medicamentos', keywords: ['farmacia', 'medicamento', 'medicamentos', 'fármaco', 'farmaco', 'pastilla', 'tableta', 'cápsula', 'capsula', 'anticonceptivo', 'anticonceptivos', 'vacuna', 'vacunas', 'antibiótico', 'antibiotico', 'ampolla', 'inyectable', 'solución inyectable', 'suero', 'anestesia', 'analgésico', 'analgésico', 'antiinflamatorio', 'hormonal', 'diu', 'implante anticonceptivo'] },
  { category: 'Equipos Médicos', keywords: ['ultrasonido', 'ecógrafo', 'ecografo', 'ecografía', 'ecografia', 'esterilizador', 'autoclave', 'colposcopio', 'colposcopia', 'monitor fetal', 'electrobisturí', 'electrobisturi', 'equipo médico', 'equipo medico', 'tensiómetro', 'tensiometro', 'oxímetro', 'oximetro', 'báscula médica', 'bascula medica', 'camilla', 'lámpara quirúrgica', 'lampara quirurgica', 'reparación equipo', 'calibración'] },
  { category: 'Laboratorio', keywords: ['laboratorio', 'lab ', 'análisis', 'analisis', 'cultivo', 'biopsia', 'citología', 'citologia', 'papanicolau', 'pap ', 'examen', 'prueba', 'reactivo', 'reactivos', 'muestra', 'histología', 'histologia', 'anatomía patológica', 'patología', 'patologia', 'serología', 'serologia', 'hematología', 'hematologia', 'ultralab', 'bioanalisis'] },
  { category: 'Mantenimiento', keywords: ['mantenimiento', 'reparación', 'reparacion', 'técnico', 'tecnico', 'servicio técnico', 'servicio tecnico', 'calibración', 'calibracion', 'instalación', 'instalacion', 'plomero', 'electricista', 'pintura', 'aire acondicionado', 'climatización', 'climatizacion'] },
  { category: 'Higiene y Limpieza', keywords: ['limpieza', 'desinfectante', 'desinfección', 'desinfeccion', 'jabón', 'jabon', 'cloro', 'alcohol', 'antiséptico', 'antiseptico', 'lejía', 'lejia', 'detergente', 'germicida', 'hipoclorito', 'amonio cuaternario', 'toallas desechables', 'papel higiénico', 'servilletas', 'escoba', 'trapeador', 'guantes limpieza'] },
  // Categorías generales
  { category: 'Suministros', keywords: ['endesa', 'iberdrola', 'naturgy', 'gas natural', 'electricidad', 'luz', ' gas', 'agua', 'telefonica', 'movistar', 'vodafone', 'orange', 'telecomunicaciones', 'internet', 'edenorte', 'edesur', 'edeeste', 'claro', 'altice', 'wind'] },
  { category: 'Tecnología', keywords: ['apple', 'google', 'microsoft', 'amazon', 'aws', 'hosting', 'dominio', 'software', 'saas', 'informática', 'informatica', 'ordenador', 'computadora', 'movil', 'telefono', 'rack', 'servidor', 'nube', 'cloud', 'sistema de gestión', 'historia clínica digital'] },
  { category: 'Servicios Profesionales', keywords: ['abogado', 'gestor', 'asesor', 'consultor', 'notario', 'arquitecto', 'honorarios', 'auditor', 'contable', 'fiscal', 'laboral', 'contador', 'contaduría', 'contaduria', 'servicios contables'] },
  { category: 'Material Oficina', keywords: ['staples', 'office depot', 'papel', 'toner', 'impresora', 'material oficina', 'papelería', 'papeleria', 'cartuchos', 'bolígrafos', 'folders', 'archivador', 'formularios', 'recetarios', 'sellos'] },
  { category: 'Alimentación', keywords: ['mercadona', 'carrefour', 'lidl', 'aldi', 'dia', 'supermercado', 'restaurant', 'catering', 'comida', 'cafetería', 'cafeteria', 'mcdonald', 'burger', 'pizza', 'colmado', 'panadería', 'panaderia'] },
  { category: 'Transporte', keywords: ['gasolinera', 'combustible', 'gasolina', 'diesel', 'renfe', 'iberia', 'vueling', 'ryanair', 'taxi', 'uber', 'parking', 'peaje', 'autopista', 'autobus', 'metro', 'gulf', 'texaco', 'shell', 'pdv'] },
  { category: 'Marketing', keywords: ['meta', 'facebook', 'instagram', 'google ads', 'publicidad', 'marketing', 'diseño', 'imprenta', 'redes sociales', 'agencia', 'seo', 'sem', 'contenido', 'banner', 'folleto', 'brochure'] },
  { category: 'Alojamiento', keywords: ['hotel', 'airbnb', 'booking', 'hostal', 'apartamento', 'parador', 'meliá', 'melia', 'nh hotel', 'riu'] },
]

export function categorize(extraction) {
  const searchText = [
    extraction.vendor,
    extraction.notes,
    ...(extraction.lineItems || []).map((i) => i.description),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  for (const rule of RULES) {
    if (rule.keywords.some((kw) => searchText.includes(kw))) {
      return rule.category
    }
  }

  return 'Otros'
}
