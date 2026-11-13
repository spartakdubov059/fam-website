(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root)root.FAMMultiPhotos=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  const MAX_PHOTOS=5;
  const VALID_MIME=new Set(["image/jpeg","image/png","image/webp"]);
  function validate(files){
    if(!Array.isArray(files)||files.length<2||files.length>MAX_PHOTOS)
      throw new Error("Выберите от 2 до 5 фотографий.");
    if(files.some(file=>!file||!VALID_MIME.has(file.type)))
      throw new Error("Поддерживаются только JPG, PNG и WebP.");
    return files;
  }
  async function queue({sb,listingId,userId,files,prepareImageForUpload,getImageExtension,makeUniqueFileSuffix}){
    validate(files);
    const storage=sb.storage.from("listing-images-pending"),paths=[],urls=[];
    try{
      let total=0;
      for(const file of files){
        const safe=await prepareImageForUpload(file,5*1024*1024,1600);
        if(!safe||!VALID_MIME.has(safe.type)||safe.size>5*1024*1024)
          throw new Error("Неверный размер или формат фотографии.");
        total+=safe.size;
        if(total>15*1024*1024)
          throw new Error("Суммарный размер фотографий превышает 15 МБ.");
        const path=userId+"/listing_"+userId+"_"+makeUniqueFileSuffix()+"."+getImageExtension(safe);
        const {error}=await storage.upload(path,safe,{cacheControl:"600",upsert:false,contentType:safe.type});
        if(error)throw new Error("Ошибка загрузки: "+error.message);
        paths.push(path);
        const {data,error:signedError}=await storage.createSignedUrl(path,600);
        if(signedError||!data?.signedUrl)throw new Error("Невозможно подготовить приватную ссылку.");
        urls.push(data.signedUrl);
      }
      const {data,error}=await sb.functions.invoke("fam-photo-batch",{
        body:{listing_id:listingId,image_urls:urls}
      });
      if(error||!data?.ok||data.status!=="pending")
        throw new Error("Не удалось сохранить фотографии в очередь проверки.");
      return {ok:true,status:"pending",count:urls.length};
    }catch(error){
      if(paths.length){try{await storage.remove(paths);}catch{}}
      throw error;
    }
  }
  return Object.freeze({queue,validate,MAX_PHOTOS});
});
