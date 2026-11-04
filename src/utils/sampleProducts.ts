export interface SampleProductPreset {
  id: string;
  title: string;
  price: string;
  brandName: string;
  modelOrVariant?: string;
  visiblePackagingText?: string;
  brandVoice: string;
  targetAudience: string;
  visualStyle: string;
  categoryHint: string;
  renderCanvasImage: () => string;
}

function drawEspressoMachine(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 720;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  // Studio stone background
  const bg = ctx.createLinearGradient(0, 0, 720, 720);
  bg.addColorStop(0, '#EBE6DF');
  bg.addColorStop(0.65, '#D8CFC4');
  bg.addColorStop(1, '#BFB3A4');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 720, 720);

  // Travertine surface table line
  ctx.fillStyle = '#C9BDAI';
  ctx.fillRect(0, 540, 720, 180);
  ctx.strokeStyle = '#B2A493';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 540);
  ctx.lineTo(720, 540);
  ctx.stroke();

  // Soft studio contact shadow
  ctx.fillStyle = 'rgba(20, 18, 16, 0.22)';
  ctx.beginPath();
  ctx.ellipse(360, 560, 195, 26, 0, 0, Math.PI * 2);
  ctx.fill();

  // Main Matte Obsidian Chassis
  ctx.fillStyle = '#181A1F';
  ctx.beginPath();
  ctx.roundRect(195, 160, 330, 390, 18);
  ctx.fill();

  // Brushed Brass Top Rail & Drip Tray
  const brass = ctx.createLinearGradient(195, 0, 525, 0);
  brass.addColorStop(0, '#B58938');
  brass.addColorStop(0.5, '#E5C168');
  brass.addColorStop(1, '#9E7428');
  ctx.fillStyle = brass;
  ctx.beginPath();
  ctx.roundRect(195, 160, 330, 32, [18, 18, 0, 0]);
  ctx.fill();

  ctx.fillStyle = brass;
  ctx.beginPath();
  ctx.roundRect(185, 515, 350, 38, 8);
  ctx.fill();

  // Recessed Brewing Alcove
  ctx.fillStyle = '#0D0E12';
  ctx.beginPath();
  ctx.roundRect(225, 290, 270, 220, 10);
  ctx.fill();

  // Pressure Gauge Dial (Center-top)
  ctx.beginPath();
  ctx.arc(360, 238, 34, 0, Math.PI * 2);
  ctx.fillStyle = '#F7F4EE';
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#D4AF5A';
  ctx.stroke();

  // Gauge needle (9 bar)
  ctx.strokeStyle = '#C83E2B';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(360, 238);
  ctx.lineTo(380, 218);
  ctx.stroke();

  // Grouphead & Walnut Portafilter Handle
  ctx.fillStyle = '#C9A44C';
  ctx.fillRect(320, 290, 80, 42);

  // Walnut handle extending right
  const walnut = ctx.createLinearGradient(390, 310, 575, 330);
  walnut.addColorStop(0, '#5B341B');
  walnut.addColorStop(0.5, '#7A4928');
  walnut.addColorStop(1, '#442511');
  ctx.fillStyle = walnut;
  ctx.beginPath();
  ctx.roundRect(390, 302, 185, 22, 11);
  ctx.fill();

  // Ceramic Espresso Cup on Tray
  ctx.fillStyle = '#F8F6F2';
  ctx.beginPath();
  ctx.roundRect(322, 435, 76, 75, [4, 4, 24, 24]);
  ctx.fill();

  // Crema layer inside cup
  ctx.fillStyle = '#B86B28';
  ctx.fillRect(328, 442, 64, 12);

  // Subtle product model engraving
  ctx.fillStyle = '#D4AF5A';
  ctx.font = '600 13px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('VELOCE BARISTA PRO · 9 BAR DUAL BOILER', 360, 181);

  return canvas.toDataURL('image/png');
}

function drawBotanicalSerum(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 720;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  // Warm limestone studio backdrop
  const bg = ctx.createLinearGradient(0, 0, 720, 720);
  bg.addColorStop(0, '#F5EFE6');
  bg.addColorStop(0.6, '#E6D9C6');
  bg.addColorStop(1, '#D2C0A8');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 720, 720);

  // Stone podium block
  ctx.fillStyle = '#DFD3C3';
  ctx.beginPath();
  ctx.roundRect(140, 500, 440, 110, 8);
  ctx.fill();

  // Contact shadow
  ctx.fillStyle = 'rgba(65, 42, 20, 0.2)';
  ctx.beginPath();
  ctx.ellipse(360, 505, 115, 18, 0, 0, Math.PI * 2);
  ctx.fill();

  // Botanical eucalyptus silhouette accent behind bottle
  ctx.fillStyle = '#5F745C';
  ctx.beginPath();
  ctx.ellipse(245, 360, 48, 80, -0.45, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#738A6F';
  ctx.beginPath();
  ctx.ellipse(475, 390, 42, 70, 0.5, 0, Math.PI * 2);
  ctx.fill();

  // Amber Frosted Glass Bottle Body
  const amber = ctx.createLinearGradient(270, 240, 450, 505);
  amber.addColorStop(0, '#B85D19');
  amber.addColorStop(0.45, '#D97925');
  amber.addColorStop(1, '#7C3709');
  ctx.fillStyle = amber;
  ctx.beginPath();
  ctx.roundRect(275, 245, 170, 260, [32, 32, 16, 16]);
  ctx.fill();

  // Bottle Neck & Gold Collar
  ctx.fillStyle = '#93440E';
  ctx.fillRect(328, 205, 64, 42);

  ctx.fillStyle = '#D8B467';
  ctx.beginPath();
  ctx.roundRect(320, 165, 80, 46, 6);
  ctx.fill();

  // Matte Cream Rubber Dropper Bulb
  ctx.fillStyle = '#F7F3EB';
  ctx.beginPath();
  ctx.roundRect(336, 102, 48, 66, [24, 24, 4, 4]);
  ctx.fill();

  // Minimalist Apothecary Cream Label
  ctx.fillStyle = '#FAF6F0';
  ctx.beginPath();
  ctx.roundRect(289, 300, 142, 165, 4);
  ctx.fill();

  // Label Typography
  ctx.fillStyle = '#1E1B18';
  ctx.font = '700 16px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('SOLARIS BOTANICA', 360, 336);

  ctx.fillStyle = '#8C5828';
  ctx.font = '600 12px "DM Sans", sans-serif';
  ctx.fillText('20% VITAMIN C + FERULIC', 360, 364);

  ctx.fillStyle = '#57524C';
  ctx.font = '400 11px "DM Sans", sans-serif';
  ctx.fillText('Cold-Pressed Sea Buckthorn', 360, 392);
  ctx.fillText('Cellular Radiance Elixir', 360, 410);
  ctx.fillText('30 ML / 1.0 FL OZ', 360, 444);

  return canvas.toDataURL('image/png');
}

function drawTrailRunningShoe(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 720;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  // Dark slate studio atmosphere
  const bg = ctx.createLinearGradient(0, 0, 720, 720);
  bg.addColorStop(0, '#18202C');
  bg.addColorStop(1, '#0D1117');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 720, 720);

  // Volcanic rock plinth
  ctx.fillStyle = '#212834';
  ctx.beginPath();
  ctx.moveTo(90, 520);
  ctx.lineTo(630, 490);
  ctx.lineTo(670, 620);
  ctx.lineTo(60, 620);
  ctx.closePath();
  ctx.fill();

  // High-stack Nitrogen Foam Midsole (Crisp Off-White + Electric Vermilion)
  ctx.fillStyle = '#F1F5F9';
  ctx.beginPath();
  ctx.moveTo(145, 445);
  ctx.quadraticCurveTo(360, 465, 585, 415);
  ctx.lineTo(598, 472);
  ctx.quadraticCurveTo(365, 515, 130, 498);
  ctx.closePath();
  ctx.fill();

  // Vibram Lugged Outsole
  ctx.fillStyle = '#EA580C';
  ctx.beginPath();
  ctx.moveTo(132, 492);
  ctx.quadraticCurveTo(365, 512, 595, 468);
  ctx.lineTo(590, 486);
  ctx.quadraticCurveTo(365, 528, 136, 508);
  ctx.closePath();
  ctx.fill();

  // Engineered Ripstop Mesh Upper (Slate + Vermilion Speed Stripes)
  const upper = ctx.createLinearGradient(155, 260, 560, 445);
  upper.addColorStop(0, '#334155');
  upper.addColorStop(0.55, '#475569');
  upper.addColorStop(1, '#EA580C');
  ctx.fillStyle = upper;
  ctx.beginPath();
  ctx.moveTo(155, 445);
  ctx.lineTo(185, 295);
  ctx.lineTo(295, 325);
  ctx.lineTo(355, 270);
  ctx.lineTo(555, 395);
  ctx.lineTo(580, 420);
  ctx.quadraticCurveTo(360, 462, 155, 445);
  ctx.closePath();
  ctx.fill();

  // Carbon Plate Window & Speed Graphic
  ctx.strokeStyle = '#FB923C';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(230, 395);
  ctx.lineTo(465, 365);
  ctx.stroke();

  ctx.fillStyle = '#F8FAFC';
  ctx.font = '700 15px "JetBrains Mono", monospace';
  ctx.fillText('AEROPEAK CARBON X3', 240, 426);

  return canvas.toDataURL('image/png');
}

export const SAMPLE_PRODUCT_PRESETS: SampleProductPreset[] = [
  {
    id: 'veloce-espresso',
    title: 'Veloce Barista Pro Dual-Boiler Espresso Machine',
    price: '$849.00',
    brandName: 'Veloce Milano',
    modelOrVariant: 'Barista Pro · 9 Bar Dual Boiler',
    visiblePackagingText: 'VELOCE BARISTA PRO · 9 BAR DUAL BOILER',
    brandVoice: 'Luxury & Editorial',
    targetAudience: 'Inferred: Home specialty coffee enthusiasts and design-conscious urban professionals',
    visualStyle: 'Warm architectural morning light, tactile brass and walnut close-ups, slow-motion espresso extraction',
    categoryHint: 'Kitchen Appliances · Specialty Coffee',
    renderCanvasImage: drawEspressoMachine,
  },
  {
    id: 'solaris-serum',
    title: 'Solaris 20% Vitamin C + Ferulic Cellular Radiance Elixir',
    price: '$68.00',
    brandName: 'Solaris Botanica',
    modelOrVariant: '30 ML / 1.0 FL OZ Dropper Bottle',
    visiblePackagingText: 'SOLARIS BOTANICA · 20% VITAMIN C + FERULIC · Cold-Pressed Sea Buckthorn · 30 ML / 1.0 FL OZ',
    brandVoice: 'Warm & Founder-Led',
    targetAudience: 'Inferred: Skincare-savvy millennials and Gen-Z shoppers seeking clean clinical glow without irritation',
    visualStyle: 'Golden-hour limestone textures, dewy glass dropper macro shots, serene botanical studio aesthetic',
    categoryHint: 'Beauty & Skincare · Clinical Botanicals',
    renderCanvasImage: drawBotanicalSerum,
  },
  {
    id: 'aeropeak-runner',
    title: 'AeroPeak Carbon X3 Trail Running Shoe',
    price: '$215.00',
    brandName: 'AeroPeak Athletics',
    modelOrVariant: 'Carbon X3 Trail',
    visiblePackagingText: 'AEROPEAK CARBON X3',
    brandVoice: 'Technical & Performance',
    targetAudience: 'Inferred: Marathoners, ultra-trail runners, and outdoor endurance athletes',
    visualStyle: 'High-contrast volcanic terrain, dynamic speed cuts, technical midsole & carbon-plate callouts',
    categoryHint: 'Athletic Footwear · Endurance Trail',
    renderCanvasImage: drawTrailRunningShoe,
  },
];
